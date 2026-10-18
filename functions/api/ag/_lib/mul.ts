import { MUL_HOST, mulUnitUrl, prettifySlug } from "../../../../web/avatar/avatar.gallery";
import type { Env } from "./cf";
import { HttpError, nowSeconds } from "./http";

/**
 * Master Unit List lookups (docs/GALLERY.md §1a). A unit page carries the
 * unit name in `og:title` and the unit art in `og:image`; the server reads
 * them once per slug and caches them in ag_units, so MUL sees one request
 * per unit. The image is hotlinked by the page, never copied.
 */

export interface UnitRow {
  slug: string;
  name: string;
  image: string | null;
  fetched: number | null;
}

export interface MulPage {
  name: string | null;
  image: string | null;
}

const MAX_NAME_LENGTH = 80;
const MAX_IMAGE_URL_LENGTH = 300;

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d) % 0x110000))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16) % 0x110000),
    )
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** `content` of `<meta property="…">` (either attribute order), or null. */
function metaContent(html: string, property: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
    const prop = attr("property") ?? attr("name");
    const value = prop?.[2] ?? prop?.[3];
    if (value?.toLowerCase() !== property) continue;
    const content = attr("content");
    const v = content?.[2] ?? content?.[3];
    if (v !== undefined) return decodeEntities(v);
  }
  return null;
}

/** A display-safe unit name: no control chars or markup, trimmed and capped. */
export function cleanName(raw: string): string | null {
  const name = raw
    .replace(/[\p{Cc}\p{Cf}<>]/gu, "")
    .replace(/\s+/g, " ")
    // MUL titles end in " · Master Unit List" (older pages used "-" or "|").
    .replace(/\s*[|·•–—-]\s*Master Unit List\s*$/i, "")
    .trim();
  return name === "" || name.length > MAX_NAME_LENGTH ? null : name;
}

/** An image URL we are willing to hotlink: https on the MUL host only. */
export function cleanImage(raw: string, base = `https://${MUL_HOST}/`): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== MUL_HOST || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href.length > MAX_IMAGE_URL_LENGTH ? null : url.href;
}

/** Name and image from a MUL unit page's HTML. */
export function parseMulPage(html: string): MulPage {
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const title = metaContent(html, "og:title") ?? (titleTag ? decodeEntities(titleTag) : null);
  const image = metaContent(html, "og:image");
  return {
    name: title === null ? null : cleanName(title),
    image: image === null ? null : cleanImage(image),
  };
}

const FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch a MUL unit page. Returns the parsed page, `"missing"` when MUL says
 * the unit does not exist (404/410), or null when MUL can't be read.
 */
export async function fetchMulPage(slug: string): Promise<MulPage | "missing" | null> {
  try {
    const res = await fetch(mulUnitUrl(slug), {
      headers: {
        accept: "text/html",
        "user-agent": "bt10x-avatar-gallery (+https://bt10x.stoneworks.dev/gallery)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) return "missing";
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 512 * 1024);
    return parseMulPage(html);
  } catch {
    return null;
  }
}

/**
 * The cached unit for `slug`, reading MUL the first time. Throws a 400 when
 * MUL reports the unit missing; when MUL can't be read, caches a fallback
 * (prettified slug, no image) the admin page can fix later.
 */
export async function ensureUnit(env: Env, slug: string): Promise<UnitRow> {
  const cached = await env.DB.prepare(
    "SELECT slug, name, image, fetched FROM ag_units WHERE slug = ?",
  )
    .bind(slug)
    .first<UnitRow>();
  if (cached !== null) return cached;
  const page = await fetchMulPage(slug);
  if (page === "missing") throw new HttpError(400, "unknown_unit", "MUL has no such unit");
  const row: UnitRow = {
    slug,
    name: page?.name ?? prettifySlug(slug),
    image: page?.image ?? null,
    fetched: page === null ? null : nowSeconds(),
  };
  await env.DB.prepare(
    "INSERT INTO ag_units (slug, name, image, fetched) VALUES (?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING",
  )
    .bind(row.slug, row.name, row.image, row.fetched)
    .run();
  return row;
}
