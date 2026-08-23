import type { Catalog, MessageKey } from "./en.js";
import { en } from "./en.js";
import { kr } from "./kr.js";

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

/**
 * Translate `key` for `locale`, falling back silently to English when a
 * catalog entry is missing (guards locales added before translation).
 * `{param}` placeholders are replaced from `params`.
 */
export function t(
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
