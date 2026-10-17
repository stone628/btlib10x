/**
 * The slice of the Cloudflare Pages Functions and D1 APIs the gallery uses,
 * typed by hand so the repo keeps its zero-dependency rule (no
 * @cloudflare/workers-types). Shapes follow the Workers runtime.
 */

export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes: number; last_row_id: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

/** Bindings and variables set on the Pages project (docs/GALLERY.md §5a, §9). */
export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  IP_HASH_SALT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  REPORT_HIDE_THRESHOLD?: string;
  AUTO_PUBLISH?: string;
  SUBMITS_PER_DAY?: string;
  VOTES_PER_DAY?: string;
  REPORTS_PER_DAY?: string;
  KEYS_PER_DAY?: string;
  PAGE_SIZE?: string;
}

export interface Ctx<P extends string = never> {
  request: Request;
  env: Env;
  params: Record<P, string | string[]>;
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler<P extends string = never> = (ctx: Ctx<P>) => Promise<Response>;
