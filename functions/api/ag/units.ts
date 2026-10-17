import type { Handler } from "./_lib/cf";
import { listUnits, unlinkedSummary } from "./_lib/gallery";
import { guard, json } from "./_lib/http";

/**
 * GET /api/ag/units?q=: 'Mechs that have visible entries, with their top
 * avatar, plus `unlinked`: the same for entries tied to no 'Mech.
 */
export const onRequestGet: Handler = ({ request, env }) =>
  guard(async () => {
    const search = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
    return json({
      units: await listUnits(env.DB, search),
      unlinked: await unlinkedSummary(env.DB),
    });
  });
