// ---------------------------------------------------------------------------
// The banner, in every colour worth considering.
//
// Picking a hue from a table of numbers is guesswork: 208 and 214 are a world
// apart on a block face and identical on a swatch. So this prints the real
// banner once per palette, in your real terminal, and tells you the four
// 256-colour indices each one used — paste them into `HEAD` and `ACCENT` in
// packages/cli/src/banner.ts (or into a `BannerText`'s sub-brand) once you see
// one you like.
//
// The art is not redrawn here. `bannerLines` renders it exactly as `zen` does
// and the tones are swapped afterwards, index for index, so what you choose is
// what ships.
//
//   node scripts/banner-colors.mjs                     every palette
//   node scripts/banner-colors.mjs --commands          every CLI command's banner
//   node scripts/banner-colors.mjs --only cyan,violet  just these
//   node scripts/banner-colors.mjs --head Zenera --accent Meta --subtitle "Meta Agent"
//   node scripts/banner-colors.mjs --try 231,244,45,31 an ad-hoc set
//   node scripts/banner-colors.mjs --chart             the 256-colour swatches
// ---------------------------------------------------------------------------

import { parseArgs } from 'node:util';

// `bannerLines` only paints when it believes a terminal is watching, and the
// tones are read back out of the escape codes — so colour is not optional here.
process.env.FORCE_COLOR ??= '3';

const { NEO_BANNER, bannerLines } = await import('../packages/cli/src/banner.ts');

/** The four indices `banner.ts` paints with. */
const ROLES = { 231: 'face', 244: 'shade', 208: 'accent', 130: 'accentShade' };

/** Every palette lists them in this order. `ROLES` cannot say so: its keys are
 * integers, and those enumerate smallest-first whatever order they were written in. */
const ORDER = ['face', 'shade', 'accent', 'accentShade'];

/**
 * `[face, shade, accent, accentShade]`. The head pair is white-on-grey almost
 * everywhere, because the accent is the only word that carries the brand; the
 * few that change it are the ones meant to be read as a single tinted mark.
 */
const PALETTES = {
    neo: [231, 244, 208, 130],
    ember: [231, 244, 202, 124],
    amber: [231, 244, 214, 172],
    gold: [231, 244, 220, 178],
    sand: [231, 244, 223, 180],
    lime: [231, 244, 154, 106],
    green: [231, 244, 41, 29],
    emerald: [231, 244, 48, 29],
    mint: [231, 244, 121, 78],
    teal: [231, 244, 44, 30],
    cyan: [231, 244, 51, 37],
    sky: [231, 244, 39, 26],
    azure: [231, 244, 33, 25],
    steel: [231, 244, 110, 67],
    indigo: [231, 244, 105, 61],
    violet: [231, 244, 141, 97],
    purple: [231, 244, 171, 90],
    magenta: [231, 244, 201, 127],
    pink: [231, 244, 212, 169],
    rose: [231, 244, 204, 125],
    crimson: [231, 244, 197, 124],
    red: [231, 244, 196, 88],
    mono: [252, 240, 250, 244],
    ice: [195, 109, 45, 31],
    dusk: [189, 103, 141, 97],
    heat: [230, 179, 208, 130],
};

const { values } = parseArgs({
    options: {
        head: { type: 'string' },
        accent: { type: 'string' },
        subtitle: { type: 'string' },
        only: { type: 'string' },
        try: { type: 'string', multiple: true, default: [] },
        chart: { type: 'boolean', default: false },
        commands: { type: 'boolean', default: false },
    },
});

const text = {
    head: values.head ?? NEO_BANNER.head,
    accent: values.accent ?? NEO_BANNER.accent,
    subtitle: values.subtitle ?? NEO_BANNER.subtitle,
};

const ESCAPE = /\u001b\[([0-9;]*)m/g;

/** Repaint a rendered line by swapping one 256-colour index for another. */
const retint = (line, tones) =>
    line.replace(ESCAPE, (whole, codes) => {
        const role = ROLES[codes.split(';').pop()];
        return role ? whole.replace(/[0-9]+(?=m$)/, tones[role]) : whole;
    });

const swatch = (n) => `\u001b[48;5;${n}m  \u001b[0m`;
const label = (n, tones) =>
    `${swatch(tones.face)}${swatch(tones.shade)}${swatch(tones.accent)}${swatch(tones.accentShade)}` +
    `  \u001b[1m${n}\u001b[0m \u001b[2m[${ORDER.map((role) => tones[role]).join(', ')}]\u001b[0m`;

function show(name, quad) {
    const tones = Object.fromEntries(ORDER.map((role, i) => [role, quad[i]]));
    const lines = bannerLines(text, Infinity);
    if (!lines.some((line) => line.includes('\u001b['))) {
        throw new Error('banner came back uncoloured — run with FORCE_COLOR=3');
    }
    console.log(`\n  ${label(name, tones)}\n`);
    for (const line of lines) {
        console.log(retint(line, tones));
    }
}

if (values.chart) {
    // Indices 16-231 are the colour cube, 232-255 the greys; 0-15 are whatever
    // the terminal theme decided they are, so they are no use for a brand.
    for (let n = 16; n < 256; n++) {
        process.stdout.write(`\u001b[48;5;${n}m ${String(n).padStart(3)} \u001b[0m`);
        if ((n - 15) % 12 === 0) {
            process.stdout.write('\n');
        }
    }
    console.log();
} else if (values.commands) {
    const { COMMANDS, EXTERNAL } = await import('../packages/cli/src/commands/index.ts');
    const all = {
        ...Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [k, c.banner])),
        ...Object.fromEntries(Object.entries(EXTERNAL).map(([k, e]) => [k, e.banner])),
    };
    for (const [cmd, b] of Object.entries(all)) {
        if (!b) continue;
        console.log(`\n  \u001b[1mzen ${cmd}\u001b[0m  \u001b[2m[${b.hue ?? 'orange'}]\u001b[0m\n`);
        for (const line of bannerLines(b, Infinity)) {
            console.log(line);
        }
    }
} else {
    const wanted = values.only?.split(',').map((s) => s.trim());
    for (const [name, quad] of Object.entries(PALETTES)) {
        if (!wanted || wanted.includes(name)) {
            show(name, quad);
        }
    }
    for (const quad of values.try) {
        const parsed = quad.split(',').map((n) => Number(n.trim()));
        if (parsed.length !== 4 || parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
            throw new Error(`--try wants four indices 0-255, got "${quad}"`);
        }
        show('try', parsed);
    }
    console.log(
        '\n  face, shade, accent, accentShade → HEAD and ACCENT in packages/cli/src/banner.ts\n',
    );
}
