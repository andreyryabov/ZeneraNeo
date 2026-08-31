import { isObject, refName, type Schema } from './schema.ts';

// ---------------------------------------------------------------------------
// JSON Schema, printed as TypeScript
//
// The point of the exercise is token density and compiler feedback: an
// interface with a JSDoc line above each field says what sixty lines of nested
// JSON Schema say, and when the model then gets a field wrong `tsc` names the
// field. So this is the format hydration reaches for by default.
//
// It is a corpus printer rather than a function because two things need to be
// known before a single type can be printed: which names exist (so a `$ref` to
// something outside the selection can be softened rather than dangle), and
// where the discriminators are — a `oneOf` becomes a *tagged* union only if the
// tag can be pushed down onto the children, and the tag is declared on the
// parent.
// ---------------------------------------------------------------------------

export interface PrintOptions {
    /** emit `/** … *\/` above types and properties */
    docs?: boolean;
    /** truncate one comment to this many characters */
    maxDoc?: number;
    /** when given, only these properties of an object are printed */
    only?: ReadonlySet<string>;
}

interface Tag {
    property: string;
    value: string;
}

const KEYWORDS = new Set(['string', 'number', 'boolean', 'object', 'any', 'unknown', 'null']);

export class Printer {
    readonly #types: Readonly<Record<string, Schema>>;
    readonly #tags = new Map<string, Tag>();
    readonly #names = new Map<string, string>();

    constructor(types: Readonly<Record<string, Schema>>) {
        this.#types = types;
        this.#assignNames();
        this.#findTags();
    }

    /** The TypeScript identifier a type id is printed as. */
    identifier(id: string): string {
        return this.#names.get(id) ?? sanitize(id);
    }

    /** An inline type expression — what goes to the right of a colon. */
    signature(schema: unknown, depth = 0): string {
        if (schema === true || schema === undefined) {
            return 'unknown';
        }
        if (schema === false) {
            return 'never';
        }
        if (!isObject(schema)) {
            return 'unknown';
        }

        const ref = refName(schema);
        if (ref !== undefined) {
            return this.#types[ref] ? this.identifier(ref) : 'unknown';
        }
        if ('const' in schema) {
            return literal(schema.const);
        }
        if (Array.isArray(schema.enum) && schema.enum.length > 0) {
            return schema.enum.map(literal).join(' | ');
        }

        for (const [key, join] of [
            ['oneOf', ' | '],
            ['anyOf', ' | '],
            ['allOf', ' & '],
        ] as const) {
            const list = schema[key];
            if (Array.isArray(list) && list.length > 0) {
                const parts = list.map((s) => this.#wrap(s, depth));
                return dedupe(parts).join(join);
            }
        }

        const types = typesOf(schema);
        if (types.length > 1) {
            return dedupe(types.map((t) => this.#scalar(t, schema, depth))).join(' | ');
        }
        return this.#scalar(types[0], schema, depth);
    }

    /** A whole `export interface` / `export type` declaration for one id. */
    declaration(id: string, options: PrintOptions = {}): string {
        const schema = this.#types[id];
        if (!schema) {
            return '';
        }
        const name = this.identifier(id);
        const comment = this.#comment(doc(schema), options, '');
        const head = comment ? `${comment}\n` : '';
        const properties = isObject(schema.properties) ? schema.properties : undefined;

        if (!properties) {
            return `${head}export type ${name} = ${this.signature(schema)};\n`;
        }
        return `${head}export interface ${name} ${this.#body(id, schema, options)}\n`;
    }

    // -----------------------------------------------------------------------

    #body(id: string, schema: Schema, options: PrintOptions): string {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const required = new Set(
            Array.isArray(schema.required) ? schema.required.filter(isString) : [],
        );
        const tag = this.#tags.get(id);
        const lines: string[] = ['{'];

        for (const [key, value] of Object.entries(properties)) {
            if (options.only && !options.only.has(key)) {
                continue;
            }
            const type =
                tag && tag.property === key ? literal(tag.value) : this.signature(value, 1);
            lines.push(this.#comment(doc(value), options, '    '));
            lines.push(`    ${property(key)}${required.has(key) ? '' : '?'}: ${type};`);
        }

        const extra = schema.additionalProperties;
        if (extra !== undefined && extra !== false) {
            lines.push(`    [key: string]: ${this.signature(extra, 1)};`);
        }
        lines.push('}');
        // A `/** … */` line is emitted as '' when docs are off; dropping the
        // blanks here keeps the two modes from differing by whitespace.
        return lines.filter((line) => line !== '').join('\n');
    }

    /**
     * The discriminated child rendered inline: `Cat` alone is the interface,
     * but inside `type Pet = …` it is the branch, and the branch is what makes
     * `if (pet.petType === 'cat')` narrow.
     */
    #wrap(schema: unknown, depth: number): string {
        return this.signature(schema, depth + 1);
    }

    #scalar(type: string | undefined, schema: Schema, depth: number): string {
        switch (type) {
            case 'null':
                return 'null';
            case 'boolean':
                return 'boolean';
            case 'integer':
            case 'number':
                return 'number';
            case 'string':
                return 'string';
            case 'array': {
                const items = schema.prefixItems;
                if (Array.isArray(items)) {
                    return `[${items.map((s) => this.signature(s, depth + 1)).join(', ')}]`;
                }
                const inner = this.signature(schema.items, depth + 1);
                return /[ |&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
            }
            case 'object':
                return this.#inline(schema, depth);
            default:
                return schema.properties || schema.additionalProperties
                    ? this.#inline(schema, depth)
                    : 'unknown';
        }
    }

    /** An object with no name of its own, printed where it stands. */
    #inline(schema: Schema, depth: number): string {
        const properties = isObject(schema.properties) ? schema.properties : undefined;
        if (!properties) {
            const extra = schema.additionalProperties;
            return extra === undefined || extra === true || extra === false
                ? 'Record<string, unknown>'
                : `Record<string, ${this.signature(extra, depth + 1)}>`;
        }
        // Past a few levels an inline object stops being readable and the
        // graph has a named node for it anyway.
        if (depth >= 3) {
            return 'Record<string, unknown>';
        }
        const required = new Set(
            Array.isArray(schema.required) ? schema.required.filter(isString) : [],
        );
        const parts = Object.entries(properties).map(
            ([key, value]) =>
                `${property(key)}${required.has(key) ? '' : '?'}: ${this.signature(value, depth + 1)}`,
        );
        return parts.length > 0 ? `{ ${parts.join('; ')} }` : 'Record<string, unknown>';
    }

    #comment(text: string, options: PrintOptions, indent: string): string {
        if (!options.docs || !text) {
            return '';
        }
        const max = options.maxDoc ?? 200;
        const one = text.replace(/\s+/g, ' ').trim();
        const cut = one.length > max ? `${one.slice(0, max - 1)}…` : one;
        return `${indent}/** ${cut.replace(/\*\//g, '*\u200b/')} */`;
    }

    /** Ids differ, identifiers may not; the second claimant is suffixed. */
    #assignNames(): void {
        const taken = new Set<string>();
        for (const id of Object.keys(this.#types)) {
            let name = sanitize(id);
            for (let n = 2; taken.has(name); n++) {
                name = `${sanitize(id)}${n}`;
            }
            taken.add(name);
            this.#names.set(id, name);
        }
    }

    /**
     * Both spellings of a discriminated union: the tag beside a `oneOf`, and
     * the tag on a base type the children `allOf` into.
     */
    #findTags(): void {
        for (const [id, schema] of Object.entries(this.#types)) {
            const discriminator = schema.discriminator;
            if (!isObject(discriminator) || typeof discriminator.propertyName !== 'string') {
                continue;
            }
            const property = discriminator.propertyName;
            const mapping = isObject(discriminator.mapping) ? discriminator.mapping : {};

            for (const [value, target] of Object.entries(mapping)) {
                const child = typeof target === 'string' ? tail(target) : undefined;
                if (child && this.#types[child]) {
                    this.#tags.set(child, { property, value });
                }
            }
            for (const child of this.#children(id, schema)) {
                if (!this.#tags.has(child)) {
                    this.#tags.set(child, { property, value: child });
                }
            }
        }
    }

    #children(id: string, schema: Schema): string[] {
        const branches = [schema.oneOf, schema.anyOf].filter(Array.isArray).flat();
        const named = branches.map(refName).filter(isString);
        if (named.length > 0) {
            return named;
        }
        // The `allOf` idiom: the base declares the tag, the children point back.
        return Object.entries(this.#types)
            .filter(([, other]) =>
                (Array.isArray(other.allOf) ? other.allOf : []).some((s) => refName(s) === id),
            )
            .map(([other]) => other);
    }
}

// ---------------------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === 'string';

function typesOf(schema: Schema): (string | undefined)[] {
    const type = schema.type;
    if (Array.isArray(type)) {
        return type.filter(isString);
    }
    return [isString(type) ? type : undefined];
}

function dedupe(parts: string[]): string[] {
    return [...new Set(parts)];
}

function literal(value: unknown): string {
    if (typeof value === 'string') {
        return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return 'unknown';
}

/** A key that is not a plain identifier has to be quoted. */
export function property(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key.replace(/'/g, "\\'")}'`;
}

function doc(schema: unknown): string {
    if (!isObject(schema)) {
        return '';
    }
    const description = schema.description ?? schema.title;
    return isString(description) ? description : '';
}

function tail(pointer: string): string {
    return decodeURIComponent(
        (pointer.split('/').pop() ?? '').replace(/~1/g, '/').replace(/~0/g, '~'),
    );
}

function sanitize(id: string): string {
    const cleaned = id.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+/, '');
    const safe = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `T${cleaned}`;
    return KEYWORDS.has(safe) ? `${safe}_` : safe || 'Anonymous';
}
