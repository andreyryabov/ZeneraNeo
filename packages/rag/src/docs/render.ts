import { bold, dim } from '@zenera/cli/lib';
import type { Assembly, Excerpt, Piece } from './assemble.ts';
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
