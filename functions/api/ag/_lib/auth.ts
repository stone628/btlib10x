import type { Env } from "./cf";
import { HttpError } from "./http";

/**
 * Anonymous device keys (docs/GALLERY.md §4): a random 256-bit secret the
 * page keeps in localStorage and sends as `Authorization: Bearer <key>`. Only
 * its SHA-256 hash is stored, so a leaked database holds nothing usable.
 */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A fresh device key (43 base64url chars). */
export function newDeviceKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** The bearer key on the request, or null when there is none or it is malformed. */
export function bearerKey(request: Request): string | null {
  const m = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  const key = m?.[1];
  return key !== undefined && KEY_RE.test(key) ? key : null;
}

/**
 * The hash of the request's device key, if it is a known key. Unknown keys
 * read as anonymous; banned keys are refused outright.
 */
export async function optionalVoter(env: Env, request: Request): Promise<string | null> {
  const key = bearerKey(request);
  if (key === null) return null;
  const hash = await sha256Hex(key);
  const row = await env.DB.prepare("SELECT banned FROM ag_keys WHERE hash = ?")
    .bind(hash)
    .first<{ banned: number }>();
  if (row === null) return null;
  if (row.banned) throw new HttpError(403, "banned");
  return hash;
}

/** Like optionalVoter, but the key is required. */
export async function requireVoter(env: Env, request: Request): Promise<string> {
  const hash = await optionalVoter(env, request);
  if (hash === null) throw new HttpError(401, "no_key", "missing or unknown device key");
  return hash;
}

/** Salted hash of the client IP, for rate limits; the raw IP is never stored. */
export async function ipHash(env: Env, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `ip:${await sha256Hex(`${env.IP_HASH_SALT ?? ""}|${ip}`)}`;
}
