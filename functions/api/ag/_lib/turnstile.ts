import type { Env } from "./cf";
import { HttpError } from "./http";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Check a Turnstile token with Cloudflare; throws a 403 when it does not pass. */
export async function verifyTurnstile(env: Env, request: Request, token: string): Promise<void> {
  const secret = env.TURNSTILE_SECRET;
  if (secret === undefined || secret === "") {
    throw new HttpError(503, "not_configured", "TURNSTILE_SECRET is not set");
  }
  if (token === "" || token.length > 2048) throw new HttpError(403, "bot_check_failed");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip !== null) form.append("remoteip", ip);
  let ok = false;
  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body: form });
    ok = res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    throw new HttpError(503, "bot_check_unavailable");
  }
  if (!ok) throw new HttpError(403, "bot_check_failed");
}
