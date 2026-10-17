import { ipHash, requireVoter } from "../../_lib/auth";
import type { Handler } from "../../_lib/cf";
import { config } from "../../_lib/config";
import { toggleVote } from "../../_lib/gallery";
import { guard, idParam, json } from "../../_lib/http";
import { rateLimit } from "../../_lib/rate";

/** POST /api/ag/avatars/:id/vote: toggle the key's vote ("this avatar fits this 'Mech"). */
export const onRequestPost: Handler<"id"> = ({ request, env, params }) =>
  guard(async () => {
    const id = idParam(params.id);
    const voter = await requireVoter(env, request);
    await rateLimit(env, "vote", [voter, await ipHash(env, request)], config(env).votesPerDay);
    return json(await toggleVote(env.DB, id, voter));
  });
