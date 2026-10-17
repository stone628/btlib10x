import { mulUnitUrl } from "../../../web/avatar/avatar.gallery";
import type { Handler } from "./_lib/cf";
import { guard, json } from "./_lib/http";

/**
 * GET /api/ag/export: the collection, one row per 'Mech with its top-voted
 * visible avatar (ties go to the earliest submission).
 */
export const onRequestGet: Handler = ({ env }) =>
  guard(async () => {
    const { results } = await env.DB.prepare(
      "SELECT u.slug, u.name, a.q, a.votes, a.id FROM ag_units u " +
        "JOIN ag_avatars a ON a.id = (SELECT b.id FROM ag_avatars b " +
        "WHERE b.unit = u.slug AND b.hidden = 0 ORDER BY b.votes DESC, b.id ASC LIMIT 1) " +
        "ORDER BY u.name",
    ).all<{ slug: string; name: string; q: string; votes: number; id: number }>();
    return json({
      generated: new Date().toISOString(),
      units: results.map((r) => ({ ...r, mul: mulUnitUrl(r.slug) })),
    });
  });
