import { keyPublicId } from "./avatar.gallery";

/**
 * Browser side of the gallery API (functions/api/ag/, docs/GALLERY.md §3):
 * the anonymous device key, Turnstile tokens and typed fetch helpers. Used by
 * the gallery page (with its Submit panel) and the admin page.
 */

export interface GalleryUnit {
  slug: string;
  name: string;
  image: string | null;
}

/**
 * An entry as the public, cached reads return it (`/avatars`,
 * `/avatars/:id`): the same for every visitor, so it says nothing about this
 * browser (functions/api/ag/_lib/cache.ts).
 */
export interface PublicEntry {
  id: number;
  q: string;
  /** null when the submitter named no 'Mech. */
  unit: GalleryUnit | null;
  votes: number;
  created: number;
  /** Public ID of the submitter (avatar.gallery.ts publicId). */
  by: string | null;
}

/** A PublicEntry with this browser's marks painted in by `withMarks`. */
export interface GalleryEntry extends PublicEntry {
  /** This browser's key liked it. */
  voted: boolean;
  /** This browser's key submitted it. */
  mine: boolean;
}

export interface UnitSummary extends GalleryUnit {
  count: number;
  top: string;
}

export interface GalleryConfig {
  turnstileSiteKey: string;
  pageSize: number;
  autoPublish: boolean;
}

/** An API error; `code` matches the server's stable error codes. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const API = "/api/ag";
const KEY_STORAGE = "bt10x.ag.key";

export function storedKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function storeKey(key: string | null): void {
  try {
    if (key === null) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Storage blocked: the key lives for this page only.
  }
  memoryKey = key;
  window.dispatchEvent(new Event(KEY_EVENT));
}

/** Fired on `window` whenever the device key is stored or cleared. */
export const KEY_EVENT = "bt10x-ag-key";

/** This browser's public ID ("you: 7Hq3xKpa"), or null before it has a key. */
export async function myPublicId(): Promise<string | null> {
  const key = currentKey();
  return key === null ? null : keyPublicId(key);
}

/** Whether this browser holds a device key yet. */
export function hasKey(): boolean {
  return currentKey() !== null;
}

let memoryKey: string | null = null;

function currentKey(): string | null {
  return storedKey() ?? memoryKey;
}

/** This browser's device key, or null before it has one. */
export function deviceKey(): string | null {
  return currentKey();
}

/** A device key's shape (functions/api/ag/_lib/auth.ts newDeviceKey). */
export const DEVICE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Ask the server about a key brought from another browser; resolves to its
 * public ID. Throws ApiError `no_key` (unknown) or `banned`.
 */
export async function checkKey(key: string): Promise<string> {
  const { pid } = await api<{ pid: string }>("/keys", { key });
  return pid;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean; key?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const key = init.key ?? currentKey();
  if (key !== null && init.auth !== false) headers.authorization = `Bearer ${key}`;
  const req: RequestInit = { method: init.method ?? "GET", headers };
  if (init.body !== undefined) req.body = JSON.stringify(init.body);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, req);
  } catch {
    throw new ApiError(0, "network", "network error");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? "http_error", data.message ?? res.statusText);
  }
  return data as T;
}

/**
 * GET a public, cached gallery read (`/avatars…`, `/units…`). Sent without
 * the device key: the server ignores it on these routes, and leaving it off
 * keeps the request identical for every visitor. The server answers
 * `cache-control: no-cache` with an ETag, so the browser keeps the body and
 * revalidates it on each call; an unchanged gallery costs a body-less 304
 * (functions/api/ag/_lib/cache.ts).
 */
export function publicGet<T>(path: string): Promise<T> {
  return api<T>(path, { auth: false });
}

/**
 * The entries with this browser's "liked" and "yours" marks, from
 * `GET /api/ag/me?ids=…`, the personal half the cached reads leave out. With
 * no key yet, nothing is liked or yours and no request is made. If the call
 * fails (offline, banned key) the entries still show, just unmarked: the
 * marks are decoration, and a like or delete re-checks on the server anyway.
 */
export async function withMarks(entries: PublicEntry[]): Promise<GalleryEntry[]> {
  const unmarked = () => entries.map((e) => ({ ...e, voted: false, mine: false }));
  if (entries.length === 0 || currentKey() === null) return unmarked();
  let marks: { voted: number[]; mine: number[] };
  try {
    marks = await api<{ voted: number[]; mine: number[] }>(
      `/me?ids=${entries.map((e) => e.id).join(",")}`,
    );
  } catch {
    return unmarked();
  }
  const voted = new Set(marks.voted);
  const mine = new Set(marks.mine);
  return entries.map((e) => ({ ...e, voted: voted.has(e.id), mine: mine.has(e.id) }));
}

let configPromise: Promise<GalleryConfig> | null = null;

export function galleryConfig(): Promise<GalleryConfig> {
  configPromise ??= api<GalleryConfig>("/config", { auth: false });
  return configPromise;
}

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      language?: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScript: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () =>
      window.turnstile !== undefined ? resolve(window.turnstile) : reject(new Error("turnstile"));
    s.onerror = () => {
      turnstileScript = null;
      reject(new ApiError(0, "bot_check_unavailable", "could not load Turnstile"));
    };
    document.head.append(s);
  });
  return turnstileScript;
}

/**
 * One single-use Turnstile token, from a widget rendered into `host` (usually
 * invisible in Managed mode; it shows a checkbox only when Cloudflare wants
 * one). The widget is removed once it answers.
 */
export async function turnstileToken(host: HTMLElement): Promise<string> {
  const [ts, cfg] = await Promise.all([loadTurnstile(), galleryConfig()]);
  const slot = document.createElement("div");
  host.replaceChildren(slot);
  return new Promise((resolve, reject) => {
    let id = "";
    const done = (fn: () => void) => {
      fn();
      queueMicrotask(() => {
        try {
          ts.remove(id);
        } catch {
          // Already gone.
        }
        slot.remove();
      });
    };
    id = ts.render(slot, {
      sitekey: cfg.turnstileSiteKey,
      theme: "dark",
      language: document.documentElement.lang === "ko" ? "ko" : "en",
      callback: (token) => done(() => resolve(token)),
      "error-callback": () =>
        done(() => reject(new ApiError(403, "bot_check_failed", "Turnstile failed"))),
      "expired-callback": () =>
        done(() => reject(new ApiError(403, "bot_check_failed", "Turnstile expired"))),
    });
  });
}

/** The device key, minting one (after a Turnstile check in `host`) the first time. */
export async function ensureKey(host: HTMLElement): Promise<string> {
  const have = currentKey();
  if (have !== null) return have;
  const turnstile = await turnstileToken(host);
  const { key } = await api<{ key: string }>("/keys", {
    method: "POST",
    body: { turnstile },
    auth: false,
  });
  storeKey(key);
  return key;
}

/**
 * Run an authenticated call; if the server no longer knows the stored key
 * (a reset database), mint a new one and retry once.
 */
export async function withKey<T>(host: HTMLElement, call: () => Promise<T>): Promise<T> {
  await ensureKey(host);
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError && e.code === "no_key") {
      storeKey(null);
      await ensureKey(host);
      return call();
    }
    throw e;
  }
}
