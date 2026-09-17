import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { invokedAs } from './args.ts';
import { paths, readJson, writeJson } from './home.ts';
import { envOf, type KeyEntry, type KeyStore, type Provider } from './keys.ts';
import {
    credentialError,
    cut,
    cyan,
    dim,
    note,
    pad,
    plain,
    red,
    styled,
    usageError,
    write,
    yellow,
} from './term.ts';
import { answerWidth, segmentsOf, wrap } from './tui/wrap.ts';

// ---------------------------------------------------------------------------
// The meta agent
//
// `zen meta` drives GitHub Copilot CLI over a zen project: same project, same
// keys, same conventions about what is an answer and what is narration. The
// two vocabularies meet here and nowhere else — a zen model ref and a zen key
// entry go in, copilot's `COPILOT_*` environment comes out — so there is one
// place to correct when either side moves.
//
// Everything reaches the child through its environment. A key on an argv is
// readable by every process on the machine, and the whole point of the keyring
// is that it is not.
// ---------------------------------------------------------------------------

/** What `copilot help providers` accepts. There is no google or vertex type. */
type CopilotType = 'openai' | 'anthropic';

export const PROMPT_DIR = '.github/prompts';
const PROMPT_SUFFIX = '.prompt.md';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The variable a project's `.env` names it with — a zen ref, not a wire id. */
export const MODEL_ENV = 'ZENERA_META_MODEL';

export type ModelSource = 'flag' | 'shell' | 'env' | 'store' | 'project' | 'default';

export interface ModelChoice {
    /** a zen ref: `vertex/gemini-3.8-flash`, or a bare id for the default provider */
    ref: string;
    from: ModelSource;
}

export interface ModelSources {
    flag?: string;
    /** `ZENERA_META_MODEL` as it stood before the project's `.env` was folded in */
    shell?: string;
    /** the same variable after it was, which is the `.env` answer when they differ */
    env?: string;
    stored?: string;
    /** the project's `agents.yaml` `model:` */
    project?: string;
    /** what a held key recommends, when nothing above answered */
    fallback?: string;
}

/** Where the answer is looked for, best first. */
export const ORDER: readonly ModelSource[] = [
    'flag',
    'shell',
    'env',
    'store',
    'project',
    'default',
];

export function chooseModel(sources: ModelSources): ModelChoice | undefined {
    const at: Record<ModelSource, string | undefined> = {
        flag: sources.flag,
        // `.env` only fills gaps, so an answer that survived it came from the shell
        shell: sources.shell,
        env: sources.shell ? undefined : sources.env,
        store: sources.stored,
        project: sources.project,
        default: sources.fallback,
    };
    for (const from of ORDER) {
        const ref = at[from]?.trim();
        if (ref) {
            return { ref, from };
        }
    }
    return undefined;
}

export const SOURCE_LABELS: Record<ModelSource, string> = {
    flag: '--model',
    shell: `${MODEL_ENV} (shell)`,
    env: `${MODEL_ENV} (.env)`,
    store: 'zen meta model',
    project: 'agents.yaml model:',
    default: 'recommended',
};

// ---------------------------------------------------------------------------
// What to run when nobody said
//
// A first `zen meta` should work on a machine that has a key and nothing else,
// so the last resort is the best model the keys on hand can buy rather than an
// error. Deep tier deliberately: this agent is pointed at the project itself,
// and a cheap model reading a specification is a false economy.
// ---------------------------------------------------------------------------

/** First of each row is the default; the rest are what `--pick` offers beside it. */
export const RECOMMENDED: Partial<Record<Provider, readonly string[]>> = {
    openai: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    anthropic: ['claude-opus-5', 'claude-sonnet-5'],
    vertex: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    google: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    openrouter: ['anthropic/claude-opus-5', 'openai/gpt-5.6-sol'],
};

/** Which provider is tried first when several are held. */
const PREFERENCE: readonly Provider[] = ['anthropic', 'openai', 'vertex', 'google', 'openrouter'];

/** The recommended ref for the first provider with a key, or for `only`. */
export function defaultRef(store: KeyStore, only?: Provider): string | undefined {
    for (const provider of only ? [only] : PREFERENCE) {
        const id = RECOMMENDED[provider]?.[0];
        if (id && store.active(provider)) {
            return `${provider}/${id}`;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// The store
//
// A model for the meta agent is a personal choice about a tool, like a key and
// unlike an agent's model, which is committed and shared. So it lives beside
// the keyring rather than in `agents.yaml`. One file for the whole meta
// surface: an agent and an effort level can join it without another.
// ---------------------------------------------------------------------------

export interface MetaFile {
    version: 1;
    model?: string;
}

const EMPTY: MetaFile = { version: 1 };

export const readMeta = (): Promise<MetaFile> => readJson<MetaFile>(paths.meta(), EMPTY);

export function writeMeta(file: MetaFile): void {
    writeJson(paths.meta(), file);
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

const PROVIDER_NAMES = new Set<string>(['openai', 'anthropic', 'google', 'vertex', 'openrouter']);

/**
 * `vertex/gemini-3.8-flash` splits; `gpt-5.6-sol` does not. Only a known provider
 * counts as a prefix, because `google/gemini-3.8-flash` is also a perfectly good
 * bare id on an endpoint that speaks publisher names.
 *
 * The colon form is the library's own — `openai:gpt-5.6-sol`, and with an api
 * selector `openai/responses:gpt-5.6-sol` — which is what arrives when the ref
 * came from `agents.yaml`.
 */
export function splitRef(ref: string): { provider?: Provider; id: string } {
    const colon = ref.indexOf(':');
    if (colon > 0) {
        const head = ref.slice(0, colon).split('/')[0];
        if (PROVIDER_NAMES.has(head)) {
            return { provider: head as Provider, id: ref.slice(colon + 1) };
        }
    }
    const slash = ref.indexOf('/');
    if (slash < 0) {
        return { id: ref };
    }
    const head = ref.slice(0, slash);
    return PROVIDER_NAMES.has(head)
        ? { provider: head as Provider, id: ref.slice(slash + 1) }
        : { id: ref };
}

/**
 * The provider a misspelt prefix was reaching for, if that is what it is.
 *
 * `vertes/gemini-3.8-flash` is shaped exactly like the OpenRouter id
 * `meta-llama/llama-4`, so an unknown prefix cannot be an error on its own —
 * only one close enough to a real provider name to be a slip of the hand.
 */
export function misspelledProvider(ref: string): Provider | undefined {
    const slash = ref.indexOf('/');
    if (slash <= 0) {
        return undefined;
    }
    const head = ref.slice(0, slash).toLowerCase();
    if (PROVIDER_NAMES.has(head)) {
        return undefined;
    }
    for (const name of PROVIDER_NAMES) {
        // Two, so that a transposition — which Levenshtein counts twice — reads
        // as the typo it is. No provider name is short enough for that to be loose.
        if (distance(head, name) <= 2) {
            return name as Provider;
        }
    }
    return undefined;
}

/** Levenshtein, one row at a time. Both operands are a word long. */
function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) {
        return 3;
    }
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + cost);
        }
        row = next;
    }
    return row[b.length];
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const TYPES: Record<Provider, CopilotType> = {
    openai: 'openai',
    anthropic: 'anthropic',
    google: 'openai',
    vertex: 'openai',
    openrouter: 'openai',
};

const BASE_URLS: Partial<Record<Provider, string>> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Copilot offers its tools as OpenAI *custom* tools, which the completions API
 * rejects outright — `400 Invalid value: 'custom'`. Only the responses API
 * takes them, and only the reasoning models serve it, so the wire API follows
 * the model rather than being a flag nobody would know to set.
 */
export function wireApi(provider: Provider, id: string): string | undefined {
    return provider === 'openai' && /^(gpt-5|o[34])/.test(id) ? 'responses' : undefined;
}

export interface Wiring {
    provider: Provider;
    /** what the model is called on the wire */
    model: string;
    /** every `COPILOT_*` name and value, ready to hand to the child */
    env: Record<string, string>;
    /** names whose values are secret, for `--secret-env-vars` and for masking */
    secret: string[];
    /** anything true but unwelcome: a location that will be slow, a stale default */
    warnings: string[];
}

/**
 * Turns a zen key entry and a model id into copilot's environment.
 *
 * `COPILOT_PROVIDER_BASE_URL` is what activates BYOK at all, so every provider
 * gets one — including OpenAI, whose url copilot would otherwise have reached
 * through a GitHub account we are deliberately not using.
 */
export function wire(store: KeyStore, entry: KeyEntry, id: string): Wiring {
    const provider = entry.provider as Provider;
    const env: Record<string, string> = {};
    const secret: string[] = [];
    const warnings: string[] = [];

    env.COPILOT_PROVIDER_TYPE = TYPES[provider];
    env.COPILOT_MODEL = id;

    if (provider === 'vertex') {
        const project = store.projectOf(entry)?.id;
        if (!project) {
            throw credentialError(
                `no GCP project on ${entry.provider}/${entry.name}`,
                'set one: zen key add vertex --project <id>',
            );
        }
        const location = entry.location?.trim() || 'global';
        if (location === 'global') {
            warnings.push('location `global` adds about ten seconds of cold start');
        }
        env.COPILOT_PROVIDER_BASE_URL = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi`;
        // Vertex speaks publisher names on the wire and knows nothing of zen's
        // provider prefix; the bare id stays as the model *id* so copilot can
        // still match its catalogue for token limits and tool support.
        env.COPILOT_PROVIDER_WIRE_MODEL = id.includes('/') ? id : `google/${id}`;
        env.COPILOT_PROVIDER_MODEL_ID = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
    } else {
        const url = BASE_URLS[provider];
        if (!url) {
            throw credentialError(`no BYOK endpoint known for ${provider}`);
        }
        env.COPILOT_PROVIDER_BASE_URL = url;
    }

    const api = wireApi(provider, id);
    if (api) {
        env.COPILOT_PROVIDER_WIRE_API = api;
    }

    if (entry.holds === 'file') {
        // A Google access token is good for an hour and a session is not, so
        // copilot is told how to mint one rather than handed one that will be
        // stale by the time it matters.
        env.COPILOT_PROVIDER_API_KEY_COMMAND = `${invokedAs('zen')} key token ${entry.provider}`;
        env[envOf(entry)] = store.fileOf(entry);
    } else {
        env.COPILOT_PROVIDER_API_KEY = store.reveal(entry);
        secret.push('COPILOT_PROVIDER_API_KEY');
    }

    return { provider, model: env.COPILOT_PROVIDER_WIRE_MODEL ?? id, env, secret, warnings };
}

/** Values a `--dry-run` may print. A key is four characters and an apology. */
export function masked(env: Record<string, string>, secret: readonly string[]): string[] {
    return Object.entries(env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${secret.includes(name) ? '••••' : value}`);
}

// ---------------------------------------------------------------------------
// Stored prompts
//
// Copilot reads `AGENTS.md`, `.github/skills/` and `.github/agents/`, but it
// has no notion of `.github/prompts/*.prompt.md` — the files an editor offers
// as slash commands. Reading one and handing over its body is the whole of
// `zen meta run`, and it is why that subcommand exists.
// ---------------------------------------------------------------------------

/** `/project-review`, `project-review`, `project-review.prompt.md` or a path. */
export function promptPath(dir: string, name: string): string {
    const bare = name.replace(/^\//, '');
    if (bare.includes('/') || bare.endsWith('.md')) {
        return `${dir}/${bare}`;
    }
    return `${dir}/${PROMPT_DIR}/${bare}${PROMPT_SUFFIX}`;
}

export interface StoredPrompt {
    name: string;
    path: string;
    description?: string;
    body: string;
}

/**
 * Frontmatter is the editor's business — `mode`, `tools`, `description` — and
 * none of it means anything to copilot, so only the body is sent. `description`
 * is kept for the one line of narration that says which prompt is running.
 */
export function readPrompt(path: string, name: string, text: string): StoredPrompt {
    let body = text;
    let description: string | undefined;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (match) {
        body = text.slice(match[0].length);
        const found = /^description:\s*(.+)$/m.exec(match[1]);
        description = found?.[1].trim().replace(/^['"]|['"]$/g, '');
    }
    return { name, path, description, body: body.trim() };
}

export async function loadPrompt(dir: string, name: string): Promise<StoredPrompt> {
    const path = promptPath(dir, name);
    if (!existsSync(path)) {
        const known = await listPrompts(dir);
        throw usageError(
            `no prompt named ${name.replace(/^\//, '')}`,
            known.length > 0
                ? `try: ${known.map((p) => `/${p}`).join(', ')}`
                : `put one in ${PROMPT_DIR}/`,
        );
    }
    return readPrompt(path, name.replace(/^\//, ''), await readFile(path, 'utf8'));
}

export async function listPrompts(dir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    try {
        const names = await readdir(`${dir}/${PROMPT_DIR}`);
        return names
            .filter((n) => n.endsWith(PROMPT_SUFFIX))
            .map((n) => n.slice(0, -PROMPT_SUFFIX.length))
            .sort();
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

export interface Binary {
    command: string;
    args: string[];
    from: 'path' | 'npx';
}

/**
 * A `copilot` already installed is used as it is; otherwise `npx` fetches one.
 * Note that finding the name on `PATH` is not the same as finding the CLI —
 * an editor may have put a shim there that installs it on first run — so this
 * only decides how to launch, never whether it will work.
 */
export function locate(has = (cmd: string): boolean => onPath(cmd)): Binary {
    return has('copilot')
        ? { command: 'copilot', args: [], from: 'path' }
        : { command: 'npx', args: ['--yes', '@github/copilot'], from: 'npx' };
}

function onPath(cmd: string): boolean {
    const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
    return dirs.some((d) => existsSync(`${d}/${cmd}`));
}

// ---------------------------------------------------------------------------
// Output
//
// Copilot's JSONL is a transcript, not an answer: tool calls, reasoning, model
// bookkeeping, and — among them — the message it finished with. Re-rendering
// it is what keeps zen's one rule true, that stdout is the answer and stderr
// is the story of getting there, so `zen meta run … > out.md` holds the answer
// alone the same way `zen run` does.
// ---------------------------------------------------------------------------

interface Event {
    type: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface Outcome {
    /** the last thing the agent said that was not a preamble to a tool call */
    answer: string;
    exitCode: number;
    sessionId?: string;
    usage?: Record<string, unknown>;
    events: Event[];
}

export interface Sink {
    answer(text: string): void;
    narrate(line: string): void;
    warn(line: string): void;
    /** Kept by the log, never shown: the step-by-step nobody reads while it runs. */
    detail?(line: string): void;
    /** A transient last row, replaced each time and never kept. '' removes it. */
    status?(line: string): void;
    /** Called once when the run ends, so a repainting sink can clear itself. */
    close?(): void;
}

export const terminalSink: Sink = {
    answer: (text) => write(text),
    narrate: (line) => note(line),
    warn: (line) => note(red(line)),
};

/** Rows of narration the window keeps on screen. */
export const WINDOW_ROWS = 8;

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

/** How often the status row is redrawn — the wave's frame, not the clock's. */
export const FRAME_MS = 80;

// Dimmest first, crest last. Written as escapes rather than `styleText` because
// a named colour has no ramp, which is also why `styled()` has to be asked.
const WAVE = [
    '\u001b[0;38;5;24m',
    '\u001b[0;38;5;31m',
    '\u001b[0;38;5;38m',
    '\u001b[0;38;5;45m',
    '\u001b[0;38;5;51m',
    '\u001b[1;38;5;159m',
    '\u001b[1;38;5;231m',
];
const RESET = '\u001b[0m';

/** Blank columns past the end, so a sweep reads as a pass and not a loop. */
const WAVE_GAP = 12;

/**
 * One frame of a bright crest travelling left to right through the text.
 *
 * Waiting is the whole of what the status row says, and a number that changes
 * once a second says it badly — a still frame is what a hung run looks like.
 * The visible text is untouched, so the width the box aligns to does not move:
 * the colour is entirely escape codes, which `pad` and `cut` already discount.
 */
export function shimmer(text: string, frame: number, on = styled()): string {
    if (!on) {
        return text;
    }
    const chars = [...text];
    const head = frame % (chars.length + WAVE_GAP);
    let out = '';
    let tone = -1;
    for (let i = 0; i < chars.length; i++) {
        // The crest sits on the head and the tail drags behind it, to the left.
        const behind = head - i;
        const step = behind >= 0 && behind < WAVE.length ? WAVE.length - 1 - behind : 0;
        if (step !== tone) {
            out += WAVE[step];
            tone = step;
        }
        out += chars[i];
    }
    return `${out}${RESET}`;
}

/**
 * Narration held to a fixed number of rows that rewrite themselves in place.
 *
 * A long run is hundreds of tool calls, and printing each as its own line
 * scrolls the question, the model line and every warning off the top of the
 * screen — by the end the terminal holds a transcript nobody asked for and the
 * answer is somewhere in the middle of it. Only the last few steps say what it
 * is doing now, which is the only thing narration is for; the rest is in the
 * session copilot recorded.
 *
 * Warnings are not narration: they leave the window and stay on the screen.
 *
 * Without a terminal there is nothing to rewrite over, so every line is its
 * own — which is what a CI log wants anyway.
 */
export function windowSink(rows = WINDOW_ROWS): Sink {
    if (!process.stderr.isTTY) {
        return terminalSink;
    }
    const kept: string[] = [];
    let tail = '';
    let painted = 0;
    let tailPainted = false;
    let lastInner = 0;

    // The frame must stay under the viewport: a block taller than the screen
    // scrolls its own top away, and then the cursor-up erase falls short and
    // strands a copy of every repaint. The two border rows count towards it.
    const height = (): number => Math.max(1, Math.min(rows, (process.stderr.rows ?? 24) - 4));
    const columns = (): number => Math.max(20, (process.stderr.columns ?? 80) - 1);
    const innerOf = (): number => columns() - 4;

    const erase = (): void => {
        if (painted > 0) {
            process.stderr.write(`\u001b[${painted}A\u001b[0J`);
            painted = 0;
        }
    };

    // Every row must be one row: a wrapped line breaks the cursor arithmetic.
    const row = (line: string, inner: number): string =>
        `${cyan(BOX.v)} ${pad(cut(line, inner), inner)} ${cyan(BOX.v)}`;

    const paint = (): void => {
        erase();
        // slice(-0) is the whole array, so a window with no room for narration
        // has to be spelled out.
        const room = height() - (tail ? 1 : 0);
        const show = room > 0 ? kept.slice(-room) : [];
        if (tail) {
            show.push(tail);
        }
        if (show.length === 0) {
            tailPainted = false;
            return;
        }
        const inner = innerOf();
        const rule = BOX.h.repeat(inner + 2);
        const framed = [
            cyan(`${BOX.tl}${rule}${BOX.tr}`),
            ...show.map((l) => row(l, inner)),
            cyan(`${BOX.bl}${rule}${BOX.br}`),
        ];
        process.stderr.write(framed.map((l) => `${l}\n`).join(''));
        painted = framed.length;
        tailPainted = tail !== '';
        lastInner = inner;
    };

    return {
        answer: (text) => {
            erase();
            write(text);
        },
        narrate: (line) => {
            kept.push(...line.split('\n'));
            if (kept.length > height() * 4) {
                kept.splice(0, kept.length - height());
            }
            paint();
        },
        warn: (line) => {
            erase();
            note(red(line));
            paint();
        },
        status: (line) => {
            const inner = innerOf();
            // Redrawing the whole frame at frame rate flickers, so once the row
            // is on screen only the row is rewritten: two up to reach it past
            // the bottom rule, two back down to where the cursor was resting.
            const inPlace = line !== '' && painted > 0 && tailPainted && inner === lastInner;
            tail = line;
            if (inPlace) {
                process.stderr.write(`\u001b[2A\r${row(line, inner)}\u001b[0K\u001b[2B\r`);
                return;
            }
            paint();
        },
        close: erase,
    };
}

/**
 * The answer in the same box `zen run` draws it in: bounded width, rounded
 * rule, fenced blocks kept as they were written.
 *
 * Redirected output gets the text and nothing else — `zen meta run ... > out.md`
 * is meant to produce a file you can read, not one with a border down its side.
 */
export function answerBox(text: string, columns = process.stdout.columns ?? 80): string[] {
    if (!process.stdout.isTTY) {
        return text.split('\n');
    }
    const outer = answerWidth(columns);
    const inner = outer - 4;
    const body: string[] = [];
    for (const segment of segmentsOf(text)) {
        if (segment.code) {
            // Indentation is the meaning of a fenced block, so it is cut rather
            // than reflowed.
            body.push(dim(`\u250c\u2500${segment.title ? ` ${segment.title}` : ''}`));
            body.push(...segment.lines.map((l) => `${dim('\u2502')} ${cut(l, inner - 2)}`));
            body.push(dim('\u2514\u2500'));
        } else {
            body.push(...wrap(segment.lines.join('\n'), inner));
        }
    }
    const rule = BOX.h.repeat(outer - 2);
    return [
        '',
        dim(`${BOX.tl}${rule}${BOX.tr}`),
        ...body.map((l) => `${dim(BOX.v)} ${pad(l, inner)} ${dim(BOX.v)}`),
        dim(`${BOX.bl}${rule}${BOX.br}`),
        '',
    ];
}

// ---------------------------------------------------------------------------
// The log
//
// The window shows the last few steps and the answer goes to stdout, so the
// middle of a long run is gone by the time anyone wants it. The log is the
// whole of it — prompt, every step, the answer — written as it happens, so a
// second terminal can `tail -f` a run that is still going.
// ---------------------------------------------------------------------------

export interface Log {
    readonly path: string;
    /** Where the answer alone goes, beside the log and openable on its own. */
    readonly answerPath: string;
    line(text: string): void;
    saveAnswer(text: string): void;
    close(): void;
}

/** `<project>/.tmp/logs/meta.<when>.log`, opened for append. */
export function openLog(dir: string, now = new Date()): Log {
    const two = (n: number): string => String(n).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
        `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const folder = `${dir}/.tmp/logs`;
    mkdirSync(folder, { recursive: true });
    const path = `${folder}/meta.${stamp}.log`;
    const answerPath = `${folder}/meta.${stamp}.md`;
    const file = createWriteStream(path, { flags: 'a' });
    return {
        path,
        answerPath,
        line: (text) => {
            file.write(`${plain(text)}\n`);
        },
        saveAnswer: (text) => {
            writeFileSync(answerPath, text.endsWith('\n') ? text : `${text}\n`);
        },
        close: () => {
            file.end();
        },
    };
}

/** Everything the sink is told, kept by the log too — and the detail only there. */
function tee(sink: Sink, log: Log): Sink {
    return {
        answer: (text) => sink.answer(text),
        narrate: (line) => {
            log.line(line);
            sink.narrate(line);
        },
        detail: (line) => log.line(line),
        warn: (line) => {
            log.line(line);
            sink.warn(line);
        },
        status: (line) => sink.status?.(line),
        close: () => sink.close?.(),
    };
}

/**
 * Folds one event into the outcome and says what, if anything, to show for it.
 *
 * `assistant.message` carries both the running commentary and the final word;
 * what separates them is `toolRequests`, so the last message that asked for no
 * tool is the answer and the rest are narration.
 */
export function absorb(event: Event, out: Outcome, sink: Sink, width: number): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
        case 'assistant.message': {
            const content = String(data.content ?? '').trim();
            const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
            if (requests.length === 0) {
                out.answer = content;
            } else if (content) {
                sink.narrate(cut(content.replace(/\s+/g, ' '), width));
            }
            break;
        }
        case 'tool.execution_start': {
            const args = (data.arguments ?? {}) as Record<string, unknown>;
            const what = String(args.command ?? args.description ?? data.toolName ?? '').trim();
            // Step-by-step belongs in the log: on screen it is a wall of `$`
            // saying less than the one line of commentary above it.
            sink.detail?.(`$ ${what.replace(/\s+/g, ' ')}`);
            break;
        }
        case 'tool.execution_complete': {
            if (data.success === false) {
                sink.detail?.(`  ${String(data.toolName ?? 'the tool')} failed`);
            }
            break;
        }
        case 'session.tools_updated': {
            if (data.model) {
                sink.detail?.(`model ${String(data.model)}`);
            }
            break;
        }
        case 'session.error': {
            sink.warn(String(data.message ?? 'the session failed'));
            break;
        }
        case 'model.call_failure': {
            const status = data.statusCode ? ` (${String(data.statusCode)})` : '';
            sink.warn(
                `${cut(String(data.errorMessage ?? 'the model call failed'), width)}${status}`,
            );
            break;
        }
        case 'result': {
            out.exitCode = Number(event.exitCode ?? 0);
            out.sessionId = event.sessionId as string | undefined;
            out.usage = event.usage as Record<string, unknown> | undefined;
            break;
        }
        default:
            break;
    }
    out.events.push(event);
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface Launch {
    binary: Binary;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    sink?: Sink;
    log?: Log;
    width?: number;
    /** injected by the tests, which have no copilot and want none */
    spawn?: typeof nodeSpawn;
}

export async function launch(opts: Launch): Promise<Outcome> {
    const shown = opts.sink ?? windowSink();
    const sink = opts.log ? tee(shown, opts.log) : shown;
    const width = opts.width ?? Math.max(40, (process.stderr.columns ?? 100) - 4);
    const start = opts.spawn ?? nodeSpawn;
    const out: Outcome = { answer: '', exitCode: 0, events: [] };

    const child = start(opts.binary.command, [...opts.binary.args, ...opts.args], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
    });

    const stop = (signal: NodeJS.Signals) => (): void => {
        child.kill(signal);
    };
    const onInt = stop('SIGINT');
    const onTerm = stop('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    // The first model call says nothing for as long as it takes, and silence
    // after the model line is indistinguishable from a hang.
    const began = Date.now();
    let frame = 0;
    const beat = setInterval(() => {
        const seconds = Math.round((Date.now() - began) / 1000);
        sink.status?.(shimmer(`  Working... ${seconds}s`, frame++));
    }, FRAME_MS);
    beat.unref();

    child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trimEnd();
        if (text) {
            sink.narrate(dim(text));
        }
    });

    try {
        const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            let event: Event;
            try {
                event = JSON.parse(line) as Event;
            } catch {
                // Not ours to interpret, but losing it is worse than showing it.
                sink.narrate(line);
                continue;
            }
            absorb(event, out, sink, width);
        }
        const code = await new Promise<number>((resolve) => {
            child.on('close', (value) => resolve(value ?? 0));
        });
        if (out.exitCode === 0 && code !== 0) {
            out.exitCode = code;
        }
    } finally {
        clearInterval(beat);
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        // The answer is written by the caller, so the window has to be gone first.
        sink.close?.();
    }
    return out;
}

/** Non-fatal, said once, because a competing file is a silent override. */
export function providersWarning(): string | undefined {
    const configured = process.env.COPILOT_PROVIDERS_CONFIG;
    const path = configured ?? `${process.env.HOME ?? ''}/.copilot/providers.json`;
    return existsSync(path)
        ? yellow(`${path} may override the provider zen just wired`)
        : undefined;
}
