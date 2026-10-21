import { requireVoter } from "../_lib/auth";
import { cachedJson } from "../_lib/cache";
import type { Handler } from "../_lib/cf";
import { deleteEntry, getEntry } from "../_lib/gallery";
import { guard, HttpError, idParam, json } from "../_lib/http";

/**
 * GET /api/ag/avatars/:id: one visible entry. A hidden one (awaiting approval,
 * hidden by reports or by an admin, or from a banned key) answers
 * `under_review` without its avatar; a missing one `not_found`.
 *
 * Public and cached (_lib/cache.ts). Only the 200 is cached: the 404s are
 * thrown out of `build`, so they reach the client `no-store` and are asked
 * again next time (a pending entry turns visible once approved).
 */
export const onRequestGet: Handler<"id"> = (ctx) =>
  guard(async () => {
    const { env } = ctx;
    const id = idParam(ctx.params.id);
    return cachedJson(ctx, {
      key: `avatars/${id}`,
      build: async () => {
        const entry = await getEntry(env.DB, id);
        if (entry !== null) return { entry };
        const row = await env.DB.prepare("SELECT 1 AS x FROM ag_avatars WHERE id = ?")
          .bind(id)
          .first();
        throw new HttpError(404, row === null ? "not_found" : "under_review");
      },
    });
  });

/** DELETE /api/ag/avatars/:id: the submitter removes their own entry. */
export const onRequestDelete: Handler<"id"> = ({ request, env, params }) =>
  guard(async () => {
    const id = idParam(params.id);
    const voter = await requireVoter(env, request);
    const row = await env.DB.prepare("SELECT owner FROM ag_avatars WHERE id = ?")
      .bind(id)
      .first<{ owner: string }>();
    if (row === null) throw new HttpError(404, "not_found");
    if (row.owner !== voter) throw new HttpError(403, "not_owner");
    await env.DB.batch(deleteEntry(env.DB, id));
    return json({ deleted: id });
  });
