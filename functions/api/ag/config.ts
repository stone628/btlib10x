import type { Handler } from "./_lib/cf";
import { config } from "./_lib/config";
import { json } from "./_lib/http";

/** GET /api/ag/config: public settings the gallery pages need. */
export const onRequestGet: Handler = async ({ env }) => {
  const c = config(env);
  return json(
    { turnstileSiteKey: c.turnstileSiteKey, pageSize: c.pageSize, autoPublish: c.autoPublish },
    200,
    { "cache-control": "public, max-age=300" },
  );
};
