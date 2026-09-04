import type {
    Blockquote,
    Code,
    Heading,
    Html,
    List,
    ListItem,
    Table as MdTable,
    TableRow as MdTableRow,
    Paragraph,
    PhrasingContent,
    Root,
    RootContent,
} from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// ---------------------------------------------------------------------------
// A document, as structure and as lines
//
// Two things come out of here and they are deliberately different. `lines` is
// the file, verbatim, and nothing ever rewrites it: it is what gets printed
// back to whoever asked, so a citation is the document rather than a paraphrase
// of it. `blocks` is the same file read as structure — where every paragraph,
// table and fence begins and ends, and which heading it sits under — and it
// carries a NORMALIZED text that is never shown to anyone. That text is what
// gets embedded and full-text indexed.
//
// Markdown is parsed rather than pattern-matched, because the ambiguities are
// real and there are a lot of them. `---` is frontmatter at line 1, a setext H2
// after a paragraph, and a thematic break standing alone; `| a \| b | c |` is
// two cells; a blockquote continues onto a line that carries no marker. Every
// one of those would otherwise have to be got right by hand.
//
// The one thing a regex must never be pointed at is inline markup. Given the
// sentence "Use `[label](url)` syntax", a link-stripping regex emits "Use label
// syntax" and quietly mangles every document that talks about markdown. Walking
// the inline tree makes it impossible: an inlineCode node is not a link node.
// ---------------------------------------------------------------------------

/** What a line, a block or a chunk is. The vocabulary is closed on purpose. */
export type StructureKind =
    | 'heading'
    | 'paragraph'
    | 'blockquote'
    | 'list'
    | 'list_item'
    | 'table'
    | 'table_header'
    | 'table_row'
    | 'code'
    | 'frontmatter'
    | 'html'
    | 'hr';

/** Path segments carry their kind, so heading ancestors stay recoverable. */
const SEGMENT: Record<StructureKind, string> = {
    heading: 'sec',
    paragraph: 'para',
    blockquote: 'quote',
    list: 'list',
    list_item: 'item',
    table: 'table',
    table_header: 'header',
    table_row: 'row',
    code: 'code',
    frontmatter: 'fm',
    html: 'html',
    hr: 'hr',
};

/** The root of every path: a document is the structure everything else sits in. */
export const ROOT_SEGMENT = 'doc';

export type DocFormat = 'markdown' | 'text';

/**
 * A heading and everything under it, until a heading of the same depth or
 * shallower. mdast has no such node — a heading there is a SIBLING of the
 * paragraphs that follow it — so the nesting is built here.
 */
export interface Section {
    id: string;
    path: string;
    title: string;
    /** 0 for the document itself, otherwise the heading depth */
    level: number;
    /** the heading's own line; absent on the document root */
    line: number | undefined;
    parent: Section | undefined;
}

export interface TableRowBlock {
    id: string;
    path: string;
    line: number;
    cells: string[];
    /** the row as prose, so it carries its own column names */
    text: string;
}

export interface TableBlock {
    columns: string[];
    headerLine: number;
    /** the alignment row; mdast emits no node for it, so it is derived */
    separatorLine: number | undefined;
    /** the paragraph before the table, which is the only caption one ever gets */
    caption: string;
    /** the column that identifies a row, repeated into every slice of it */
    keyColumn: number;
    rows: TableRowBlock[];
}

export interface ListItemBlock {
    id: string;
    path: string;
    start: number;
    end: number;
    text: string;
}

export interface Block {
    id: string;
    path: string;
    kind: StructureKind;
    /** 1-based, inclusive */
    start: number;
    end: number;
    section: Section;
    /** normalized, never shown: this is what is embedded and indexed */
    text: string;
    items?: ListItemBlock[];
    table?: TableBlock;
}

export interface ParsedDoc {
    /** the document's name within the index — its path, and its identity */
    name: string;
    title: string;
    format: DocFormat;
    /** verbatim, CRLF normalized, 1-based when indexed as `lines[n - 1]` */
    lines: string[];
    sections: Section[];
    blocks: Block[];
}

const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml']);

// ---------------------------------------------------------------------------

/** Every ancestor of a section, the document root first, itself last. */
export function ancestry(section: Section): Section[] {
    const out: Section[] = [];
    for (let at: Section | undefined = section; at; at = at.parent) {
        out.unshift(at);
    }
    return out;
}

/** The breadcrumb, which prefixes every chunk of text under this section. */
export const headingPath = (section: Section): string =>
    ancestry(section)
        .map((s) => s.title)
        .filter(Boolean)
        .join(' > ');

/** The heading lines a chunk under this section must be rendered with. */
export const headingLines = (section: Section): number[] =>
    ancestry(section)
        .map((s) => s.line)
        .filter((line): line is number => line !== undefined);

/**
 * Everything downstream indexes `lines` by number, and mdast positions refer to
 * the exact string handed to the parser — so the normalization happens once,
 * here, and the normalized text is the only version anything ever sees.
 */
export const normalize = (text: string): string =>
    text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

export function parseDocument(source: string, name: string, format: DocFormat): ParsedDoc {
    const text = normalize(source);
    const lines = text.split('\n');
    return format === 'text' ? plain(text, lines, name) : markdown(text, lines, name);
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

interface Walk {
    lines: string[];
    counters: Map<string, number>;
    sections: Section[];
    blocks: Block[];
}

function markdown(text: string, lines: string[], name: string): ParsedDoc {
    const tree = processor.parse(text) as Root;
    const root: Section = {
        id: ROOT_SEGMENT,
        path: ROOT_SEGMENT,
        title: stripExtension(name),
        level: 0,
        line: undefined,
        parent: undefined,
    };
    const walk: Walk = { lines, counters: new Map(), sections: [root], blocks: [] };

    let section = root;
    let title = '';
    // Only ever holds the paragraph immediately before the current position,
    // which is the whole of what a markdown table gets for a caption.
    let lead = '';

    for (const node of tree.children) {
        if (node.type === 'heading') {
            const heading = node as Heading;
            const line = lineOf(heading);
            const text = collapse(inline(heading.children));
            while (section.parent && section.level >= heading.depth) {
                section = section.parent;
            }
            section = {
                id: id(walk, 'heading'),
                path: '',
                title: text,
                level: heading.depth,
                line,
                parent: section,
            };
            section.path = `${section.parent!.path}/${section.id}`;
            walk.sections.push(section);
            if (!title && heading.depth <= 2) {
                title = text;
            }
            lead = '';
            continue;
        }
        const block = blockOf(node, section, walk, lead);
        if (block) {
            walk.blocks.push(block);
            lead = block.kind === 'paragraph' ? block.text : '';
        }
    }

    return {
        name,
        title: title || stripExtension(basenameOf(name)),
        format: 'markdown',
        lines,
        sections: walk.sections,
        blocks: walk.blocks,
    };
}

function blockOf(node: RootContent, section: Section, walk: Walk, lead: string): Block | undefined {
    const start = lineOf(node);
    const end = endLineOf(node);

    switch (node.type) {
        case 'paragraph':
            return make('paragraph', collapse(inline((node as Paragraph).children)));
        case 'blockquote':
            return make('blockquote', collapse(blocks((node as Blockquote).children)));
        case 'code': {
            const code = node as Code;
            return make('code', code.value);
        }
        case 'html': {
            const stripped = collapse(tags((node as Html).value));
            return stripped.length >= 3 ? make('html', stripped) : undefined;
        }
        case 'yaml':
            return make('frontmatter', String((node as { value?: string }).value ?? ''));
        case 'thematicBreak':
            return make('hr', '');
        case 'list':
            return list(node as List, section, walk, start, end);
        case 'table':
            return table(node as MdTable, section, walk, start, end, lead);
        default:
            // A `+++` block. remark-frontmatter puts it in the tree; mdast's own
            // node union names only the `---` one.
            return (node.type as string) === 'toml'
                ? make('frontmatter', String((node as { value?: string }).value ?? ''))
                : undefined;
    }

    function make(kind: StructureKind, text: string): Block {
        const own = id(walk, kind);
        return { id: own, path: `${section.path}/${own}`, kind, start, end, section, text };
    }
}

function list(node: List, section: Section, walk: Walk, start: number, end: number): Block {
    const own = id(walk, 'list');
    const path = `${section.path}/${own}`;
    const ordinal = node.start ?? 1;

    const items = node.children.map((child, at): ListItemBlock => {
        const item = child as ListItem;
        const mine = id(walk, 'list_item');
        const marker = node.ordered ? `${ordinal + at}.` : '-';
        // The marker is kept: enumeration and step order are meaning, and a
        // numbered step reads differently from a bullet.
        return {
            id: mine,
            path: `${path}/${mine}`,
            start: lineOf(item),
            end: endLineOf(item),
            text: `${marker} ${collapse(blocks(item.children))}`.trim(),
        };
    });

    return {
        id: own,
        path,
        kind: 'list',
        start,
        end,
        section,
        text: items.map((i) => i.text).join('\n'),
        items,
    };
}

function table(
    node: MdTable,
    section: Section,
    walk: Walk,
    start: number,
    end: number,
    caption: string,
): Block {
    const own = id(walk, 'table');
    const path = `${section.path}/${own}`;
    const [header, ...body] = node.children as MdTableRow[];
    const columns = header ? cellsOf(header) : [];
    const headerLine = header ? lineOf(header) : start;
    const firstRow = body[0] ? lineOf(body[0]) : undefined;
    // mdast has no node for the alignment row — alignment lives on the table —
    // so it is the line after the header, when there is room for it.
    const separatorLine =
        firstRow === undefined || firstRow > headerLine + 1 ? headerLine + 1 : undefined;

    const rows = body.map((row): TableRowBlock => {
        const mine = id(walk, 'table_row');
        const cells = cellsOf(row);
        return {
            id: mine,
            path: `${path}/${mine}`,
            line: lineOf(row),
            cells,
            text: rowText(columns, cells),
        };
    });

    return {
        id: own,
        path,
        kind: 'table',
        start,
        end,
        section,
        text: rows.map((r) => r.text).join('\n'),
        table: {
            columns,
            headerLine,
            separatorLine,
            caption,
            keyColumn: keyColumnOf(columns, rows),
            rows,
        },
    };
}

/**
 * A data row does not contain its own column names. Stripping the pipes leaves
 * `V-200-30 3" WCC 98.2`, in which the word `Cv` appears nowhere, so a query
 * naming a column could only ever match the header line and never a row — and
 * hybrid search would silently become vector-only for every table in the
 * corpus. Pairing each cell with its header is what fixes that, and it embeds
 * better too, because `Cv: 45` is a sentence and `| 45 |` is not.
 */
export function rowText(columns: readonly string[], cells: readonly string[]): string {
    return cells
        .map((cell, at) => cellText(columns[at], cell))
        .filter(Boolean)
        .join(' ');
}

export function cellText(column: string | undefined, cell: string): string {
    const value = cell.trim();
    if (!value) {
        return '';
    }
    return column ? `${column}: ${value}.` : `${value}.`;
}

/** Column 1, unless it is numeric — a slice with no name on it is unattributable. */
function keyColumnOf(columns: readonly string[], rows: readonly TableRowBlock[]): number {
    const numeric = (at: number): boolean =>
        rows.length > 0 &&
        rows.every((row) => {
            const cell = (row.cells[at] ?? '').trim();
            return cell === '' || /^[-+]?[\d.,%\s]+$/.test(cell);
        });

    for (let at = 0; at < columns.length; at++) {
        if (!numeric(at)) {
            return at;
        }
    }
    return 0;
}

const cellsOf = (row: MdTableRow): string[] =>
    row.children.map((cell) => collapse(inline(cell.children)));

// ---------------------------------------------------------------------------
// plain text
// ---------------------------------------------------------------------------

/**
 * A `.txt` file is read as paragraphs and nothing else. It would be easy to run
 * it through the markdown parser and get headings for free, but they would be
 * invented: a line beginning with `#` in a log or a licence is not a title, and
 * an index that says it is would scope searches to sections nobody wrote.
 */
function plain(text: string, lines: string[], name: string): ParsedDoc {
    const root: Section = {
        id: ROOT_SEGMENT,
        path: ROOT_SEGMENT,
        title: stripExtension(name),
        level: 0,
        line: undefined,
        parent: undefined,
    };
    const blocks: Block[] = [];
    let at = 0;
    let ordinal = 0;

    while (at < lines.length) {
        if ((lines[at] ?? '').trim() === '') {
            at++;
            continue;
        }
        const start = at;
        while (at < lines.length && (lines[at] ?? '').trim() !== '') {
            at++;
        }
        const own = `${SEGMENT.paragraph}:${++ordinal}`;
        blocks.push({
            id: own,
            path: `${root.path}/${own}`,
            kind: 'paragraph',
            start: start + 1,
            end: at,
            section: root,
            text: collapse(lines.slice(start, at).join(' ')),
        });
    }

    const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
    return {
        name,
        title: first.length > 0 && first.length <= 80 ? first : stripExtension(basenameOf(name)),
        format: 'text',
        lines,
        sections: [root],
        blocks,
    };
}

// ---------------------------------------------------------------------------
// serialization — walking the inline tree, never a regex over the markup
// ---------------------------------------------------------------------------

function inline(nodes: readonly PhrasingContent[]): string {
    return nodes.map(one).join('');
}

function one(node: PhrasingContent): string {
    switch (node.type) {
        case 'text':
            return node.value;
        // The value, not the markup: this is the node a regex stripper eats.
        case 'inlineCode':
            return node.value;
        case 'image':
        case 'imageReference':
            // Distinguishable from a sentence on purpose.
            return node.alt ? `image: ${node.alt}` : '';
        case 'break':
            return ' ';
        // Inline html carries no words worth indexing, and its angle brackets
        // would only ever match a query by accident.
        case 'html':
            return '';
        case 'footnoteReference':
            return '';
        default:
            return 'children' in node ? inline(node.children as PhrasingContent[]) : '';
    }
}

/** Nested block content — a blockquote's paragraphs, a list item's children. */
function blocks(nodes: readonly RootContent[]): string {
    return nodes
        .map((node) => {
            switch (node.type) {
                case 'paragraph':
                case 'heading':
                    return inline(node.children as PhrasingContent[]);
                case 'code':
                    return (node as Code).value;
                case 'blockquote':
                    return blocks((node as Blockquote).children);
                case 'list':
                    return (node as List).children
                        .map((item) => blocks((item as ListItem).children))
                        .join(' ');
                case 'table':
                    return (node as MdTable).children
                        .slice(1)
                        .map((row) =>
                            rowText(cellsOf((node as MdTable).children[0]!), cellsOf(row)),
                        )
                        .join(' ');
                default:
                    return '';
            }
        })
        .filter(Boolean)
        .join(' ');
}

/** Soft wraps inside a paragraph are wrapping, not meaning, so they rejoin. */
export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const tags = (html: string): string => html.replace(/<[^>]*>/g, ' ');

// ---------------------------------------------------------------------------

function id(walk: Walk, kind: StructureKind): string {
    const segment = SEGMENT[kind];
    const next = (walk.counters.get(segment) ?? 0) + 1;
    walk.counters.set(segment, next);
    return `${segment}:${next}`;
}

const lineOf = (node: { position?: { start: { line: number } } }): number =>
    node.position?.start.line ?? 1;

const endLineOf = (node: { position?: { end: { line: number } } }): number =>
    node.position?.end.line ?? 1;

const basenameOf = (name: string): string => name.split('/').pop() ?? name;

const stripExtension = (name: string): string => name.replace(/\.[^./]+$/, '');
