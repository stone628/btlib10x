import { ipHash, requireVoter } from "../../_lib/auth";
import type { Handler } from "../../_lib/cf";
import { config } from "../../_lib/config";
import { recountReports } from "../../_lib/gallery";
import { guard, HttpError, idParam, json } from "../../_lib/http";
import { rateLimit } from "../../_lib/rate";

/** POST /api/ag/avatars/:id/report: one report per key; auto-hides at the threshold. */
export const onRequestPost: Handler<"id"> = ({ request, env, params }) =>
  guard(async () => {
    const id = idParam(params.id);
    const cfg = config(env);
    const voter = await requireVoter(env, request);
    const exists = await env.DB.prepare("SELECT 1 AS x FROM ag_avatars WHERE id = ? AND hidden = 0")
      .bind(id)
      .first();
    if (exists === null) throw new HttpError(404, "not_found");
    await rateLimit(env, "report", [voter, await ipHash(env, request)], cfg.reportsPerDay);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO ag_reports (avatar, voter) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ).bind(id, voter),
      recountReports(env.DB, id, cfg.reportHideThreshold),
    ]);
    return json({ reported: id });
  });
