import type { Env } from "./cf";

/**
 * Tunable settings (docs/GALLERY.md §5a). Each one is a Pages environment
 * variable; a missing or malformed value falls back to the default here, so
 * the dashboard only needs the ones you change.
 */
export interface Config {
  reportHideThreshold: number;
  autoPublish: boolean;
  submitsPerDay: number;
  votesPerDay: number;
  reportsPerDay: number;
  keysPerDay: number;
  pageSize: number;
  turnstileSiteKey: string;
}

/** Public, so it may live in code; the secret key never does. */
export const DEFAULT_TURNSTILE_SITE_KEY = "0x4AAAAAAFZV3_ri2orug_FJ";

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : fallback;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

export function config(env: Env): Config {
  return {
    reportHideThreshold: int(env.REPORT_HIDE_THRESHOLD, 3, 0, 1000),
    autoPublish: bool(env.AUTO_PUBLISH, true),
    submitsPerDay: int(env.SUBMITS_PER_DAY, 10, 1, 10000),
    votesPerDay: int(env.VOTES_PER_DAY, 200, 1, 100000),
    reportsPerDay: int(env.REPORTS_PER_DAY, 20, 1, 10000),
    keysPerDay: int(env.KEYS_PER_DAY, 5, 1, 1000),
    pageSize: int(env.PAGE_SIZE, 48, 1, 200),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || DEFAULT_TURNSTILE_SITE_KEY,
  };
}
