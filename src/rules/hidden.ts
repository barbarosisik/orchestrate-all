/**
 * Characters a reader can't see (step 11, research §4.3): rules-file backdoors hide instructions for the model in
 * text that looks harmless on screen. Found here: Unicode format characters (bidirectional controls, zero-width
 * characters, word joiners, tag characters, soft hyphens), control characters other than tab and line breaks,
 * Hangul fillers, the combining grapheme joiner and the variation selectors (which can carry hidden data too).
 *
 * Left alone, because they are ordinary: a byte order mark at the very start, and a zero-width joiner between
 * two emoji (family and profession emoji are built that way). The common variation selector U+FE0F (emoji
 * style) is not counted either.
 */

const HIDDEN = /[\p{Cf}\p{Cc}\u034F\u115F\u1160\u3164\uFE00-\uFE0E\uFFA0\u{E0100}-\u{E01EF}]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]);
const ZWJ = 0x200d;
const BOM = 0xfeff;
const EMOJI_STYLE = '️';

export interface HiddenFound {
  /** How many hidden characters the text holds. */
  readonly count: number;
  /** The first five kinds found, as "U+202E". */
  readonly codes: readonly string[];
}

function code(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function isHidden(chars: readonly string[], index: number): boolean {
  const char = chars[index] as string;
  if (!HIDDEN.test(char)) return false;
  const cp = char.codePointAt(0) as number;
  if (ALLOWED_CONTROLS.has(cp)) return false;
  if (cp === BOM && index === 0) return false;
  if (cp === ZWJ) {
    const before = chars[index - 1] ?? '';
    const after = chars[index + 1] ?? '';
    if ((PICTOGRAPH.test(before) || before === EMOJI_STYLE) && PICTOGRAPH.test(after)) return false;
  }
  return true;
}

/** The hidden characters in `text`. */
export function findHidden(text: string): HiddenFound {
  const chars = Array.from(text);
  let count = 0;
  const codes: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (!isHidden(chars, i)) continue;
    count += 1;
    const name = code(chars[i]?.codePointAt(0) as number);
    if (codes.length < 5 && !codes.includes(name)) codes.push(name);
  }
  return { count, codes };
}

/** `text` with each hidden character replaced by its code in brackets ("[U+202E]"), so a reader sees it. */
export function showHidden(text: string): string {
  const chars = Array.from(text);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] as string;
    out += isHidden(chars, i) ? `[${code(char.codePointAt(0) as number)}]` : char;
  }
  return out;
}
