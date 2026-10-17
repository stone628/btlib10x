import type { Env } from "./cf";
import { HttpError, nowSeconds } from "./http";

export type RateAction = "key" | "submit" | "vote" | "report";

/** Days of counters kept; older rows are pruned now and then (Pages has no cron). */
const KEEP_DAYS = 3;
const PRUNE_CHANCE = 0.02;

/**
 * Count one `action` against each of `who` (a key hash and/or an IP hash)
 * for today, and refuse with 429 once any of them is past `limit`.
 */
export async function rateLimit(
  env: Env,
  action: RateAction,
  who: readonly string[],
  limit: number,
): Promise<void> {
  const day = Math.floor(nowSeconds() / 86400);
  const stmts = who.map((w) =>
    env.DB.prepare(
      "INSERT INTO ag_rate (who, action, day, n) VALUES (?1, ?2, ?3, 1) " +
        "ON CONFLICT (who, action, day) DO UPDATE SET n = n + 1 RETURNING n",
    ).bind(w, action, day),
  );
  if (Math.random() < PRUNE_CHANCE) {
    stmts.push(env.DB.prepare("DELETE FROM ag_rate WHERE day < ?").bind(day - KEEP_DAYS));
  }
  const results = await env.DB.batch(stmts);
  for (const r of results.slice(0, who.length)) {
    const n = (r.results[0] as { n?: number } | undefined)?.n ?? 0;
    if (n > limit) throw new HttpError(429, "rate_limited", `daily ${action} limit reached`);
  }
}
