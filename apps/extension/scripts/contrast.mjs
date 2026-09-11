/**
 * Contrast gate for the palette.
 *
 * The design this UI is built to has one non-negotiable rule -- nothing that
 * carries type sits below 4.5:1 -- and the reason it needs a script rather than
 * a review is that the last regression was invisible: a token that reads
 * correctly in one theme and at 1.56:1 in the other, because the ink flipped
 * with the theme while the fill it sat on did not.
 *
 * Values are parsed out of `src/ui/styles.css` rather than duplicated here, so
 * this cannot drift from what actually ships.
 *
 *   node scripts/contrast.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLES = fileURLToPath(new URL('../src/ui/styles.css', import.meta.url));

/** WCAG 2.x text floor, and the lower floor for boundaries and focus rings. */
const TEXT_FLOOR = 4.5;
const UI_FLOOR = 3;

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

function parseHex(value) {
  const hex = value.trim().replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
}

/** `rgba(r, g, b, a)` over an opaque backdrop, which is how hairlines resolve. */
function parseRgba(value) {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/.exec(
    value.trim(),
  );
  if (match === null) return null;
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function composite(rgb, alpha, backdrop) {
  return rgb.map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha));
}

function channelLuminance(channel) {
  const unit = channel / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* -------------------------------------------------------------------------- */
/* Reading the tokens back out of the stylesheet                              */
/* -------------------------------------------------------------------------- */

/**
 * Light comes from `:root`, dark from `[data-theme='dark']`. The dark media
 * query is a third copy of the same list; the explicit selector is the one a
 * reader can actually be in, so it is the one that is checked.
 *
 * Every block is declared for `:root` and `:host` together, so the floating
 * panel's shadow root resolves them too. The selector passed in here has to
 * match that pair exactly, or this would silently read the wrong block.
 */
function readTokens(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`contrast: could not find ${selector} in styles.css`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);

  const tokens = {};
  for (const [, name, value] of block.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function resolve(tokens, name, backdropName) {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`contrast: no --${name} token`);

  if (raw.startsWith('#')) return parseHex(raw);

  const rgba = parseRgba(raw);
  if (rgba === null) throw new Error(`contrast: cannot parse --${name}: ${raw}`);
  if (rgba.alpha === 1) return rgba.rgb;

  // A translucent hairline is only meaningful over something.
  const backdrop = parseHex(tokens[backdropName]);
  return composite(rgba.rgb, rgba.alpha, backdrop);
}

/* -------------------------------------------------------------------------- */
/* The pairs that have to hold                                                */
/* -------------------------------------------------------------------------- */

const SURFACES = ['paper', 'surface', 'sunk'];

/** Every token used as type, against every surface it can land on. */
const TEXT_TOKENS = [
  { token: 'ink', note: 'body, names, values' },
  { token: 'ink-muted', note: 'helper text, urls' },
  { token: 'ink-label', note: 'field labels, eyebrows, timestamps' },
  { token: 'gold-text', note: 'plate ids, fired stamps' },
  { token: 'ok', note: 'GET, 2xx' },
  { token: 'info', note: 'POST, 3xx, focus ring' },
  { token: 'warn', note: 'PUT/PATCH, 4xx, slow durations' },
  { token: 'danger', note: 'DELETE, 5xx, failed, destructive' },
];

/** Type on a coloured fill, where both sides are tokens. */
const ON_FILL = [
  { fg: 'on-gold', bg: 'gold', floor: TEXT_FLOOR, note: 'the solid `mocked` pill' },
  { fg: 'paper', bg: 'ink', floor: TEXT_FLOOR, note: 'primary button, toast, tooltip' },
  { fg: 'gold-ink', bg: 'gold-soft', floor: TEXT_FLOOR, note: 'text selection' },
];

/**
 * Boundaries and rings, which need 3:1 rather than 4.5:1.
 *
 * `--hairline` and `--hairline-strong` are deliberately absent. They draw
 * dividers, card rings and the outlines on static pills -- decoration around
 * content that already passes on its own -- and holding them to a control
 * boundary's floor would mean drawing the whole UI in near-black lines.
 * `--edge` is the token that actually identifies a control, and it is checked.
 */
const UI_TOKENS = [
  { token: 'edge', note: 'input wells, switch-off track, secondary buttons, chips' },
  { token: 'info', note: 'focus ring' },
];

function main() {
  const css = readFileSync(STYLES, 'utf8');
  const themes = [
    { name: 'light', tokens: readTokens(css, ':root,\n:host {') },
    { name: 'dark', tokens: readTokens(css, ":root[data-theme='dark'],") },
  ];

  const failures = [];
  let checked = 0;

  for (const theme of themes) {
    // `--on-gold` is declared once, in `:root`, on purpose.
    const tokens = { ...themes[0].tokens, ...theme.tokens };

    for (const { token, note } of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        checked += 1;
        const ratio = contrast(resolve(tokens, token, surface), parseHex(tokens[surface]));
        if (ratio < TEXT_FLOOR) {
          failures.push({
            theme: theme.name,
            pair: `${token} on ${surface}`,
            ratio,
            floor: TEXT_FLOOR,
            note,
          });
        }
      }
    }

    for (const { fg, bg, floor, note } of ON_FILL) {
      checked += 1;
      const ratio = contrast(resolve(tokens, fg, bg), resolve(tokens, bg, 'paper'));
      if (ratio < floor) {
        failures.push({ theme: theme.name, pair: `${fg} on ${bg}`, ratio, floor, note });
      }
    }

    for (const { token, note } of UI_TOKENS) {
      for (const surface of SURFACES) {
        checked += 1;
        const ratio = contrast(resolve(tokens, token, surface), parseHex(tokens[surface]));
        if (ratio < UI_FLOOR) {
          failures.push({
            theme: theme.name,
            pair: `${token} on ${surface}`,
            ratio,
            floor: UI_FLOOR,
            note,
          });
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`contrast: ${String(failures.length)} of ${String(checked)} pairs below floor\n`);
    for (const failure of failures) {
      console.error(
        `  ${failure.theme.padEnd(5)} ${failure.pair.padEnd(34)} ${failure.ratio.toFixed(2)}:1  (needs ${String(failure.floor)}:1) — ${failure.note}`,
      );
    }
    process.exit(1);
  }

  console.log(`contrast: ${String(checked)} pairs checked, all at or above floor`);
}

main();
