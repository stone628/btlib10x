/**
 * Instant Action's own catalog (docs/INSTANT.md "i18n"): `en` is canonical, `ko` is
 * compile-checked against it, `kr` is accepted as an alias of `ko`. Locale
 * precedence follows the site: `?lang=`, then localStorage `bt10x.lang`,
 * then English.
 */
import { en, type MessageKey } from "./en";
import { ko } from "./ko";

export type { MessageKey };
export type LocaleId = "en" | "ko";

const CATALOGS: Record<LocaleId, Readonly<Record<MessageKey, string>>> = { en, ko };
const STORAGE_KEY = "bt10x.lang";

let current: LocaleId = "en";

export function normalizeLocale(raw: string | null): LocaleId | null {
  if (raw === null) return null;
  const v = raw.toLowerCase();
  if (v === "kr" || v === "ko") return "ko";
  return v === "en" ? "en" : null;
}

export function initLocale(): LocaleId {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage unavailable
  }
  const fromUrl = normalizeLocale(new URLSearchParams(location.search).get("lang"));
  current = fromUrl ?? normalizeLocale(stored) ?? "en";
  document.documentElement.lang = current;
  // The TUI kit stamps its own locale ("en") on <html lang> at DOMContentLoaded,
  // which comes after this module ran: stamp ours again once it has.
  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.lang = current;
  });
  return current;
}

export function locale(): LocaleId {
  return current;
}

export function setLocale(l: LocaleId): void {
  current = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // storage unavailable: the choice just won't survive a reload
  }
}

/**
 * Translate `key`; `{name}` slots are filled from `vars`. Keys built at run
 * time (`mode.walk`) fall back to English, then to the key itself.
 */
export function t(key: MessageKey | string, vars?: Record<string, string | number>): string {
  const k = key as MessageKey;
  let s = CATALOGS[current][k] ?? en[k] ?? key;
  if (vars) for (const [name, v] of Object.entries(vars)) s = s.split(`{${name}}`).join(String(v));
  return s;
}

const LOC_KEYS: Record<string, MessageKey> = {
  head: "loc.head",
  centerTorso: "loc.centerTorso",
  leftTorso: "loc.leftTorso",
  rightTorso: "loc.rightTorso",
  leftArm: "loc.leftArm",
  rightArm: "loc.rightArm",
  leftLeg: "loc.leftLeg",
  rightLeg: "loc.rightLeg",
};

/** Short location name: HD, CT, LT, … */
export function locName(loc: string): string {
  const k = LOC_KEYS[loc];
  return k ? t(k) : loc;
}
