import { composeAvatar, composeSelectedAvatar } from "./avatar.compose";
import { ARMS, HEADS, LEGS, SHOULDERS, TORSOS } from "./avatar.data";
import { applyOverrides, type Overrides, SLOTS } from "./avatar.override";
import { buildAvatarQuery, parseAvatarQuery, type UrlPart } from "./avatar.url";

/**
 * Avatar gallery rules shared by the browser pages and the Pages Functions
 * under `functions/api/ag/` (no DOM access here), so client and server never
 * disagree on what a valid submission is. See docs/GALLERY.md.
 */

/** Part keys and variant names in avatar order, as the creator's URL uses them. */
export const GALLERY_PARTS: UrlPart[] = [
  { key: "head", names: HEADS.map((v) => v.name) },
  { key: "shoulder", names: SHOULDERS.map((v) => v.name) },
  { key: "torso", names: TORSOS.map((v) => v.name) },
  { key: "arms", names: ARMS.map((v) => v.name) },
  { key: "legs", names: LEGS.map((v) => v.name) },
];

const PART_DATA = [HEADS, SHOULDERS, TORSOS, ARMS, LEGS];

const KNOWN_PARAMS: ReadonlySet<string> = new Set([
  ...GALLERY_PARTS.map((p) => p.key),
  ...SLOTS.map((s) => s.id.toLowerCase()),
]);

/** Longest query a valid avatar can produce, with room to spare. */
export const MAX_QUERY_LENGTH = 400;

export interface ParsedAvatar {
  idx: number[];
  ovr: Overrides;
}

/**
 * The canonical form of a submitted avatar query, or null when it is not a
 * complete, valid avatar: every part present with a known variant name, only
 * known params, each override an allowed glyph. Overrides that repeat the
 * variant's own glyph are dropped, so two queries that draw the same avatar
 * canonicalize to the same string.
 */
export function canonicalAvatar(query: string): string | null {
  if (query.length > MAX_QUERY_LENGTH) return null;
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const k of params.keys()) {
    if (!KNOWN_PARAMS.has(k) || seen.has(k)) return null;
    seen.add(k);
  }
  if (GALLERY_PARTS.some((p) => !params.has(p.key))) return null;
  const parsed = parseAvatarQuery(query, GALLERY_PARTS);
  if (parsed === null || parsed.ignored.length > 0) return null;
  const base = variantData(parsed.idx);
  const ovr: Overrides = {};
  for (const slot of SLOTS) {
    const ch = parsed.ovr[slot.id];
    if (ch !== undefined && ch !== (base[slot.part]?.[slot.side] ?? " ")) ovr[slot.id] = ch;
  }
  return buildAvatarQuery(GALLERY_PARTS, parsed.idx, ovr);
}

/** Variant data per part for the given variant indices. */
function variantData(idx: readonly number[]): string[] {
  return PART_DATA.map((variants, p) => variants[idx[p] ?? 0]?.data ?? "  ");
}

/** Parsed form of a stored (canonical) query. */
export function parseStoredAvatar(query: string): ParsedAvatar | null {
  const parsed = parseAvatarQuery(query, GALLERY_PARTS);
  return parsed === null ? null : { idx: parsed.idx, ovr: parsed.ovr };
}

/** Box lines for a stored query, as the creator draws it. */
export function avatarLines(query: string, selected = false): string[] {
  const parsed = parseStoredAvatar(query);
  const data =
    parsed === null ? variantData([]) : applyOverrides(variantData(parsed.idx), parsed.ovr);
  const [head, shoulder, torso, arm, leg] = data;
  return (selected ? composeSelectedAvatar : composeAvatar)(
    head ?? "  ",
    shoulder ?? "  ",
    torso ?? "  ",
    arm ?? "  ",
    leg ?? "  ",
  );
}

/** Master Unit List host; unit pages are `https://<MUL_HOST>/units/<slug>`. */
export const MUL_HOST = "masterunitlist.battletech.com";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 80;

/** A unit slug as MUL spells it in its URLs, or null. */
export function isUnitSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_LENGTH && SLUG_RE.test(slug);
}

/**
 * The unit slug from a pasted MUL unit page URL
 * (`https://masterunitlist.battletech.com/units/atlas-as7-d-dc`), or null.
 * Accepts http(s), a trailing slash, a query or hash, and mixed case; nothing
 * else of the URL is kept.
 */
export function parseMulUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== MUL_HOST || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  const m = /^\/units\/([^/]+)\/?$/i.exec(url.pathname);
  const slug = m?.[1]?.toLowerCase();
  return slug !== undefined && isUnitSlug(slug) ? slug : null;
}

export function mulUnitUrl(slug: string): string {
  return `https://${MUL_HOST}/units/${slug}`;
}

/**
 * A best-effort readable name from a slug, for when MUL can't be read:
 * `atlas-as7-d-dc` → `Atlas AS7-D-DC`, `hunchback-hbk-4g` → `Hunchback
 * HBK-4G`, `mad-cat-prime` → `Mad Cat Prime`. The model code starts at the
 * first word with a digit, or at a short word right before it; the words
 * before are the chassis. The admin page can fix a wrong guess.
 */
export function prettifySlug(slug: string): string {
  const words = slug.split("-");
  let model = words.findIndex((w) => /\d/.test(w));
  if (model > 1 && (words[model - 1]?.length ?? 0) <= 3) model--;
  if (model <= 0) model = words.length;
  const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const chassis = words.slice(0, model).map(title).join(" ");
  const code = words.slice(model).join("-").toUpperCase();
  return code === "" ? chassis : `${chassis} ${code}`;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Length of a public ID: 8 base58 chars, about 47 bits. */
export const PUBLIC_ID_LENGTH = 8;

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The public ID shown for a device key ("you: 7Hq3xKpa", "by 7Hq3xKpa"),
 * from the key's SHA-256 hex hash (what the server stores) through a second,
 * labelled hash, so the ID reveals neither the key nor its stored hash.
 */
export async function publicId(keyHash: string): Promise<string> {
  const bytes = await sha256(`ag-pid:${keyHash}`);
  let n = 0n;
  for (const b of bytes.subarray(0, 8)) n = (n << 8n) | BigInt(b);
  let id = "";
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    id += BASE58[Number(n % 58n)];
    n /= 58n;
  }
  return id;
}

/** The public ID for a raw device key, as the browser holds it. */
export async function keyPublicId(key: string): Promise<string> {
  const hash = Array.from(await sha256(key), (b) => b.toString(16).padStart(2, "0")).join("");
  return publicId(hash);
}
