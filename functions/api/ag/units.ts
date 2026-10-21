import { cachedJson } from "./_lib/cache";
import type { Handler } from "./_lib/cf";
import { listUnits, unlinkedSummary } from "./_lib/gallery";
import { guard } from "./_lib/http";

/**
 * GET /api/ag/units?q=: 'Mechs that have visible entries, with their top
 * avatar, plus `unlinked`: the same for entries tied to no 'Mech.
 *
 * Public and cached (_lib/cache.ts). This is the gallery's most expensive
 * read (a top-avatar subquery per 'Mech, growing with the gallery), so it
 * gains the most: between two writes it runs once per data center and
 * search term instead of once per view.
 */
export const onRequestGet: Handler = (ctx) =>
  guard(async () => {
    const { env } = ctx;
    // Normalized before it becomes the cache key, so "atlas", " atlas " and
    // a 200-character paste that starts the same share one copy.
    const search = (new URL(ctx.request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
    return cachedJson(ctx, {
      key: `units?q=${encodeURIComponent(search)}`,
      build: async () => ({
        units: await listUnits(env.DB, search),
        unlinked: await unlinkedSummary(env.DB),
      }),
    });
  });
