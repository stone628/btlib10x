import type { Env } from "./cf";
import { HttpError } from "./http";

/**
 * Cloudflare Access check for the admin routes (docs/GALLERY.md §4, §9).
 * Access signs a JWT for every request it lets through; this verifies its
 * RS256 signature against the team's published keys, its audience
 * (ACCESS_AUD), issuer and expiry. Without both settings every admin request
 * is refused, so `*.pages.dev` preview URLs, which Access does not cover,
 * fail closed.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface JwtClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

const CERTS_TTL_MS = 10 * 60 * 1000;
let certsCache: { team: string; at: number; keys: Jwk[] } | null = null;

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T;
}

async function teamKeys(team: string, refresh: boolean): Promise<Jwk[]> {
  const now = Date.now();
  if (!refresh && certsCache?.team === team && now - certsCache.at < CERTS_TTL_MS) {
    return certsCache.keys;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, "access_unavailable");
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  certsCache = { team, at: now, keys };
  return keys;
}

function accessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header !== null && header !== "") return header;
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("cookie") ?? "");
  return cookie?.[1] ?? null;
}

/** The verified admin's email; throws a 403 unless Access vouches for the request. */
export async function requireAdmin(env: Env, request: Request): Promise<string> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) throw new HttpError(403, "admin_not_configured");
  const token = accessToken(request);
  if (token === null) throw new HttpError(403, "not_admin");
  const [h, p, s] = token.split(".");
  if (h === undefined || p === undefined || s === undefined) throw new HttpError(403, "not_admin");

  let header: { kid?: string; alg?: string };
  let claims: JwtClaims;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    throw new HttpError(403, "not_admin");
  }
  if (header.alg !== "RS256" || header.kid === undefined) throw new HttpError(403, "not_admin");

  let jwk = (await teamKeys(team, false)).find((k) => k.kid === header.kid);
  // Access rotates keys; a kid we have not seen means our cache is stale.
  if (jwk === undefined) jwk = (await teamKeys(team, true)).find((k) => k.kid === header.kid);
  if (jwk === undefined || jwk.kty !== "RSA") throw new HttpError(403, "not_admin");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new HttpError(403, "not_admin");

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new HttpError(403, "not_admin");
  if (claims.iss !== `https://${team}`) throw new HttpError(403, "not_admin");
  if (typeof claims.exp !== "number" || claims.exp < now) throw new HttpError(403, "not_admin");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60)
    throw new HttpError(403, "not_admin");
  return claims.email ?? "admin";
}
