import { publicId } from "../../../web/avatar/avatar.gallery";
import { ipHash, newDeviceKey, sha256Hex } from "./_lib/auth";
import type { Handler } from "./_lib/cf";
import { config } from "./_lib/config";
import { guard, json, nowSeconds, readJson, str } from "./_lib/http";
import { rateLimit } from "./_lib/rate";
import { verifyTurnstile } from "./_lib/turnstile";

/**
 * POST /api/ag/keys `{ turnstile }`: mint an anonymous device key. Only its
 * hash and public ID are stored; the key itself is returned once and kept by
 * the page.
 */
export const onRequestPost: Handler = ({ request, env }) =>
  guard(async () => {
    const body = await readJson(request);
    await verifyTurnstile(env, request, str(body, "turnstile"));
    await rateLimit(env, "key", [await ipHash(env, request)], config(env).keysPerDay);
    const key = newDeviceKey();
    const hash = await sha256Hex(key);
    const pid = await publicId(hash);
    await env.DB.prepare("INSERT INTO ag_keys (hash, pid, created) VALUES (?, ?, ?)")
      .bind(hash, pid, nowSeconds())
      .run();
    return json({ key, pid }, 201);
  });
