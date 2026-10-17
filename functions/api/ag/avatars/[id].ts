import { optionalVoter, requireVoter } from "../_lib/auth";
import type { Handler } from "../_lib/cf";
import { deleteEntry, getEntry } from "../_lib/gallery";
import { guard, HttpError, idParam, json } from "../_lib/http";

/** GET /api/ag/avatars/:id: one visible entry. */
export const onRequestGet: Handler<"id"> = ({ request, env, params }) =>
  guard(async () => {
    const entry = await getEntry(env.DB, idParam(params.id), await optionalVoter(env, request));
    if (entry === null) throw new HttpError(404, "not_found");
    return json({ entry });
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
