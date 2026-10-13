import { isAllowedGlyph, type Overrides, SLOTS } from "./avatar.override";

/**
 * Avatar state as URL query parameters, so a link (or the address bar)
 * carries the whole composition:
 *
 *   avatar.html?head=sq&shoulder=rn&torso=bt&arms=pr&legs=sf&rh=2622&la=23ac
 *
 * - One param per part (`head`, `shoulder`, `torso`, `arms`, `legs`), valued
 *   with a variant name.
 * - One param per overridden slot, the slot id in lowercase (`rh`, `lh`, ...),
 *   valued with a 4-6 digit hex code point or a single literal character.
 */
export interface UrlPart {
  key: string;
  names: readonly string[];
}

export interface UrlState {
  /** Variant index per part; parts the URL leaves out get variant 0. */
  idx: number[];
  ovr: Overrides;
  /** Params that were present but ignored, for a console warning. */
  ignored: string[];
}

/** A glyph param value: hex code point (`2622`) or one literal character (`☢`). */
export function parseGlyphParam(v: string): string | null {
  const ch = /^[0-9a-f]{4,6}$/i.test(v)
    ? Number.parseInt(v, 16) <= 0x10ffff
      ? String.fromCodePoint(Number.parseInt(v, 16))
      : null
    : v;
  return ch !== null && isAllowedGlyph(ch) ? ch : null;
}

/** State from a query string, or null when it holds no avatar params at all. */
export function parseAvatarQuery(search: string, parts: readonly UrlPart[]): UrlState | null {
  const params = new URLSearchParams(search);
  const idx = parts.map(() => 0);
  const ovr: Overrides = {};
  const ignored: string[] = [];
  let any = false;

  for (const [p, part] of parts.entries()) {
    const v = params.get(part.key);
    if (v === null) continue;
    any = true;
    const i = part.names.indexOf(v);
    if (i >= 0) idx[p] = i;
    else ignored.push(`${part.key}=${v}`);
  }
  for (const slot of SLOTS) {
    const key = slot.id.toLowerCase();
    const v = params.get(key);
    if (v === null) continue;
    any = true;
    const ch = parseGlyphParam(v);
    if (ch !== null) ovr[slot.id] = ch;
    else ignored.push(`${key}=${v}`);
  }
  return any ? { idx, ovr, ignored } : null;
}

/** Query string (without `?`) for the given state; overrides as hex code points. */
export function buildAvatarQuery(
  parts: readonly UrlPart[],
  idx: readonly number[],
  ovr: Overrides,
): string {
  const params = new URLSearchParams();
  for (const [p, part] of parts.entries()) {
    params.set(part.key, part.names[idx[p] ?? 0] ?? part.names[0] ?? "");
  }
  for (const slot of SLOTS) {
    const ch = ovr[slot.id];
    if (ch === undefined) continue;
    params.set(slot.id.toLowerCase(), (ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0"));
  }
  return params.toString();
}
