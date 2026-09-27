import type { Catalog, MessageKey } from "./en";
import { en } from "./en";
import { kr } from "./kr";

export type { Catalog, MessageKey };

/** All shipped locales. */
export const LOCALES = { en, kr } as const satisfies Record<string, Catalog>;

export type LocaleId = keyof typeof LOCALES;

export function isLocale(value: string): value is LocaleId {
  return value in LOCALES;
}

export function localeList(): string {
  return Object.keys(LOCALES).join(", ");
}

let defaultLocale: LocaleId = "en";

export function setI18nDefaultLocale(locale: LocaleId) {
  defaultLocale = locale;
}

/**
 * Translate `key` for `locale`, falling back silently to English when a
 * catalog entry is missing (guards locales added before translation).
 * `{param}` placeholders are replaced from `params`.
 */
export function i18nIn(
  locale: LocaleId,
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const catalog: Partial<Catalog> = LOCALES[locale];
  let text = catalog[key] ?? en[key];
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function i18n(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  return i18nIn(defaultLocale, key, params);
}

/**
 * Whether a Unicode code point occupies 2 columns in a CJK-aware monospace
 * font. Covers Hangul Jamo, CJK Radicals Supplement through CJK Strokes,
 * Hangul Syllables, CJK Compatibility Ideographs, Vertical Forms, CJK
 * Compatibility Forms, Halfwidth and Fullwidth Forms, and CJK Symbols/
 * Punctuation. Astral-plane characters (Emoji, CJK Unified Ideographs
 * Extension B and beyond) are caught by the `cp > 0xffff` final check.
 */
function isWideCodePoint(cp: number): boolean {
  return (
    // Hangul Jamo: U+1100..U+115F — initial/final/trailing jamo syllables.
    (cp >= 0x1100 && cp <= 0x115f) ||
    // Angle brackets rendered as wide in CJK contexts: U+2329 LEFT-POINTING,
    // U+232A RIGHT-POINTING ANGLE BRACKET (the only single-codepoint picks).
    cp === 0x2329 ||
    cp === 0x232a ||
    // CJK Radicals Supplement through CJK Strokes (and Yi syllables in
    // between): U+2E80..U+A4CF — radicals, Kangxi, ideographic description,
    // CJK symbols/punctuation, Hiragana, Katakana, Bopomofo, Hangul
    // Compatibility Jamo, Kanbun, CJK Unified Ideographs Extension A, Yi.
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    // Hangul Syllables: U+AC00..U+D7A3 — precomposed modern Hangul.
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    // CJK Compatibility Ideographs: U+F900..U+FAFF — duplicated Han chars.
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Vertical Forms: U+FE10..U+FE1F — CJK punctuation rendered vertically.
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    // CJK Compatibility Forms through Small Form Variants: U+FE30..U+FE6F
    // — compatibility punctuation, vertical/horizontal presentation forms.
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    // Halfwidth and Fullwidth Forms: U+FF00..U+FF60 — fullwidth ASCII and
    // halfwidth Katakana variants.
    (cp >= 0xff00 && cp <= 0xff60) ||
    // Fullwidth Signs: U+FFE0..U+FFE6 — fullwidth currency and math signs.
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // Any astral code point (planes 1–16): CJK Unified Ideographs
    // Extension B+, Emoji, historic scripts, etc. All render as wide in
    // CJK-aware monospace fonts.
    cp > 0xffff
  );
}

/**
 * Code-unit length padded out to the visual cell count of the string.
 * Each wide code point contributes 1 extra cell beyond its code-unit
 * count (BMP wide = 1 unit + 1 cell; astral wide = 2 units + 0 extra
 * because the wide bonus equals the surrogate-pair size).
 *
 * Pure-ASCII strings short-circuit on the first numeric scan: no
 * iterator allocation, no per-char `codePointAt`, and no range checks
 * — `getCompensatedLength` reduces to `str.length`. Non-ASCII strings
 * fall back to the iterator-based path so the existing
 * `isWideCodePoint` ranges (including astral planes) still apply.
 */
export function compensatedLength(str: string): number {
  let extra = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) continue;
    for (const ch of str.slice(i)) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp > 0x7f && isWideCodePoint(cp)) extra += 1;
    }
    break;
  }
  return str.length + extra;
}
