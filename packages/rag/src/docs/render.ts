import { bold, dim } from '@zenera/cli/lib';
import type { Assembly, Excerpt, Piece } from './assemble.ts';
import { isFailure, type ReadBlock, type ReadMany } from './lookup.ts';
import type { Match } from './search.ts';

// ---------------------------------------------------------------------------
// Putting an excerpt on a screen
//
// The structured assembly is the answer; this is one way of writing it down.
// Keeping them apart is what lets `--json` hand a model the same result a person
// reads, rather than a model being handed prose it has to parse back.
//
// Line numbers are shown because every follow-up question is phrased in them:
// read those lines, fix that table, quote that section. A passage with no
// numbers can be read but not referred to.
// ---------------------------------------------------------------------------

export interface RenderOptions {
    /** the line-number gutter; on unless something else is going to eat this */
    numbers?: boolean;
    colour?: boolean;
}

export function renderAssembly(assembly: Assembly, options: RenderOptions = {}): string {
    const out: string[] = [];
    for (const file of assembly.files) {
        out.push(...renderExcerpt(file, options), '');
    }
    if (assembly.truncated) {
        out.push('(cut short by the line budget — raise it with --max-lines)');
    }
    return out.join('\n').trimEnd();
}

export function renderExcerpt(file: Excerpt, options: RenderOptions = {}): string[] {
    const paint = options.colour === false ? (s: string) => s : undefined;
    const strong = paint ?? bold;
    const faint = paint ?? dim;
    const width = String(file.lines).length;

    return [
        `## ${strong(file.path)} ${faint(`— ${file.shown} of ${file.lines} lines`)}`,
        '',
        ...file.pieces.flatMap((piece) => renderPiece(piece, width, options, faint)),
    ];
}

function renderPiece(
    piece: Piece,
    width: number,
    options: RenderOptions,
    faint: (s: string) => string,
): string[] {
    if (piece.type === 'omission') {
        const named = piece.sections.length > 0 ? ` (${piece.sections.join(', ')})` : '';
        return [faint(`... ${piece.count} lines omitted${named} ...`), ''];
    }
    const lines = piece.lines.map((line, at) =>
        options.numbers === false
            ? line
            : `${faint(String(piece.start + at).padStart(width))} ${faint('|')} ${line}`,
    );
    return [...lines, ''];
}

/**
 * Each read under a header that is itself a read, so a citation copied from
 * the header, or the line that continues a cut block, pastes straight back.
 */
export function renderReads(read: ReadMany, options: RenderOptions = {}): string {
    const paint = options.colour === false ? (s: string) => s : undefined;
    const strong = paint ?? bold;
    const faint = paint ?? dim;

    const blocks = read.results.map((result) =>
        isFailure(result)
            ? [`## ${strong(result.target)}`, `error: ${result.error} - ${result.hint}`]
            : renderBlock(result, options, strong, faint),
    );
    return blocks.map((lines) => lines.join('\n')).join('\n\n');
}

function renderBlock(
    block: ReadBlock,
    options: RenderOptions,
    strong: (s: string) => string,
    faint: (s: string) => string,
): string[] {
    const notes = [
        block.section ? `(#${block.section})` : '',
        block.asked ? `(asked ${block.asked}; the document ends at ${block.total})` : '',
    ].filter(Boolean);
    const width = String(block.end).length;
    const out = [`## ${strong(block.target)}${notes.length ? ` ${faint(notes.join(' '))}` : ''}`];

    for (const [at, line] of block.lines.entries()) {
        out.push(
            options.numbers === false
                ? line
                : `${faint(String(block.from + at).padStart(width))} ${faint('|')} ${line}`,
        );
    }
    if (block.continue) {
        out.push(
            faint(
                block.lines.length > 0
                    ? `... truncated at line ${block.to} of ${block.end} - read ${block.continue} to continue`
                    : `... the line budget ran out before this one - read ${block.continue}`,
            ),
        );
    }
    return out;
}

/** The one-line-per-match view, for `--quiet` and for the prompt loop. */
export const matchRows = (matches: readonly Match[]): string[][] =>
    matches.map((m) => [
        m.id,
        m.kind,
        `${m.bodyStart}-${m.bodyEnd}`,
        m.score.toFixed(4),
        // Fusion ranks; these say whether the rank was worth anything.
        [m.relevance.vector?.toFixed(2), m.relevance.text?.toFixed(1)]
            .map((v) => v ?? '·')
            .join(' / '),
        m.headings.split('\n')[0] ?? '',
    ]);

export const MATCH_HEADERS = ['id', 'kind', 'lines', 'score', 'vec / txt', 'heading'] as const;
