import { appendCatalog, ensureMapRegistered, loadCatalog, VERSION } from "btlib10x";
import {
  AUTOPLAY_INTERVAL_MS,
  flushAutoPlayCommand,
  nextAutoPlayCommand,
  resetAutoplayState,
} from "./autoplay";
import { buildCollapsibleChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import { runChunks } from "./cli";
import { i18n, normalizeLocale } from "./i18n/index";
import motdText from "./MOTD.txt";
import { configLocale, newSession, promptBody, setConfigLocale } from "./session";

document.title = `bt10x terminal v${VERSION}`;

const out = document.getElementById("out") as HTMLDivElement;
const inrow = document.getElementById("inrow") as HTMLDivElement;
const promptEl = document.getElementById("prompt") as HTMLSpanElement;
const input = document.getElementById("cmd") as HTMLInputElement;

const session = newSession(42);

// Locale precedence: ?lang= in the URL, then the last choice kept in
// localStorage (every access guarded: storage may be blocked), then English.
const LANG_STORAGE_KEY = "bt10x.lang";
let savedLang: string | null = null;
try {
  savedLang = localStorage.getItem(LANG_STORAGE_KEY);
} catch {
  // storage unavailable: fall back to the default locale
}
const normalizedSaved = savedLang !== null ? normalizeLocale(savedLang) : null;
if (normalizedSaved !== null) setConfigLocale(normalizedSaved);
const urlLang = new URLSearchParams(window.location.search).get("lang");
const normalizedUrl = urlLang !== null ? normalizeLocale(urlLang) : null;
if (normalizedUrl !== null) {
  setConfigLocale(normalizedUrl);
}

/** Keep `<html lang>` and the stored choice in step with the active locale. */
function syncDocLang(): void {
  const locale = configLocale();
  document.documentElement.lang = locale;
  if (locale !== savedLang) {
    savedLang = locale;
    try {
      localStorage.setItem(LANG_STORAGE_KEY, locale);
    } catch {
      // storage unavailable: the choice just won't survive a reload
    }
  }
}
syncDocLang();

const motdBody = document.getElementById("motd-body");
if (motdBody) motdBody.innerHTML = motdText;
const topbarVersion = document.getElementById("topbar-version");
if (topbarVersion) topbarVersion.textContent = `v${VERSION}`;

const history: string[] = [];
let historyIdx = -1;
/** Half-typed line saved while ArrowUp browses history; restored past the end. */
let historyDraft = "";

function scrollToBottom(): void {
  out.scrollTop = out.scrollHeight;
}

/** Scrollback cap: oldest entries go first, keeping #inrow last. */
const MAX_SCROLLBACK = 1500;

/** Plain-text copy of a chunk for the screen-reader live region. */
function spokenText(chunk: Chunk): string[] {
  if (chunk.kind === "lines") {
    if (chunk.lines.length === 1 && chunk.lines[0] === "\f") return [];
    return [chunk.lines.join("\n")];
  }
  if (chunk.kind === "columns") {
    const rows: string[] = [];
    const n = Math.max(0, ...chunk.columns.map((c) => c.length));
    for (let i = 0; i < n; i++) rows.push(chunk.columns.map((c) => c[i] ?? "").join(" "));
    return rows;
  }
  if (chunk.kind === "collapsible") return [chunk.summary];
  return [];
}

function appendChunk(chunk: Chunk, parent: HTMLElement = out): void {
  const kind = chunk.kind;
  const insert = (el: Node): void => {
    if (parent === out) {
      out.insertBefore(el, inrow);
      while (out.childElementCount > MAX_SCROLLBACK) {
        const oldest = out.firstElementChild;
        if (oldest === null || oldest === inrow) break;
        oldest.remove();
      }
    } else parent.append(el);
    scrollToBottom();
  };

  if (kind === "board") {
    const div = document.createElement("div");
    if (chunk.renderer) chunk.renderer(chunk.info, div);
    insert(div);
    return;
  }

  if (kind === "columns") {
    const div = document.createElement("div");
    div.className = "columns";
    for (const column of chunk.columns) {
      const col = document.createElement("div");
      col.className = "column";
      col.textContent = column.join("\n");
      div.append(col);
    }
    insert(div);
    return;
  }

  if (kind === "collapsible") {
    const details = document.createElement("details");
    details.className = "collapsible";
    const summary = document.createElement("summary");
    summary.className = "no-prompt-focus";
    summary.textContent = chunk.summary;
    const body = document.createElement("div");
    body.className = "collapsible-body";
    for (const inner of chunk.chunks) {
      appendChunk(inner, body);
    }
    details.append(summary, body);
    insert(details);
    return;
  }

  if (kind === "lines") {
    if (chunk.lines.length === 0) return;
    if (parent === out && chunk.lines.length === 1 && chunk.lines[0] === "\f") {
      out.replaceChildren(inrow);
      // Re-parenting the input blurs it; restore focus so the caret stays live.
      input.focus();
      return;
    }
    const div = document.createElement("div");
    div.className = chunk.cls ?? "";
    div.textContent = chunk.lines.join("\n");
    insert(div);
    return;
  }
}

function refreshPrompt(): void {
  promptEl.textContent = `${promptBody(session)} > `;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function printError(message: string): void {
  try {
    appendChunk(buildLinesChunkWith("err", `${i18n("err.prefix")} ${message}`));
  } catch {
    // Nothing left to report through; the terminal must stay usable.
  }
}

/** Echo and run one command line; returns true when the command failed. */
function submitImpl(raw: string, record = true): boolean {
  const line = raw.trim();
  let failed = false;
  const said: string[] = [];
  try {
    const echo = document.createElement("div");
    echo.className = "cmd";
    echo.textContent = `${promptBody(session)} > ${raw}`;
    out.insertBefore(echo, inrow);
    if (record && line.length > 0) {
      if (history[history.length - 1] !== line) history.push(line);
      historyIdx = history.length;
      historyDraft = "";
    }
    for (const chunk of runChunks(session, line)) {
      if (chunk.kind === "lines" && chunk.cls === "err") failed = true;
      appendChunk(chunk, out);
      said.push(...spokenText(chunk));
    }
  } catch (e) {
    failed = true;
    const message = `${i18n("err.prefix")} ${errorMessage(e)}`;
    printError(errorMessage(e));
    said.push(message);
  }
  // Silent while autoplay is running: the demo would flood the reader.
  const live = document.getElementById("sr-live");
  if (live !== null && autoPlayTimer === null) live.textContent = said.join("\n");
  return failed;
}

function submitEpilog(): void {
  input.value = "";
  syncDocLang();
  try {
    refreshPrompt();
  } catch (e) {
    printError(errorMessage(e));
  }
  scrollToBottom();
}

/** Consecutive failed autoplay steps at an unchanged prompt before giving up. */
const AUTOPLAY_MAX_STUCK = 6;
let autoStuckPrompt: string | null = null;
let autoStuckCount = 0;

function submitAuto(raw: string): void {
  const before = promptBody(session);
  const failed = submitImpl(raw, false);
  submitEpilog();
  if (before !== autoStuckPrompt) {
    autoStuckPrompt = before;
    autoStuckCount = 0;
  }
  if (!failed) return;
  autoStuckCount += 1;
  if (autoStuckCount >= AUTOPLAY_MAX_STUCK) {
    stopAutoPlay(false);
    appendChunk(buildLinesChunkWith("banner", i18n("autoPlay.stuck")));
    refreshPrompt();
  }
}

function submitInput(raw: string) {
  stopAutoPlay(false);
  submitImpl(raw);
  submitEpilog();
}

// --- autoplay demo driver (hidden 'autoplay' command) ---

let autoPlayTimer: ReturnType<typeof setInterval> | null = null;

function stopAutoPlay(finished: boolean): void {
  if (autoPlayTimer === null) return;
  clearInterval(autoPlayTimer);
  autoPlayTimer = null;
  flushAutoPlayCommand();
  if (finished) {
    appendChunk(buildLinesChunkWith("banner", i18n("autoPlay.done")));
    refreshPrompt();
  }
}

function startAutoPlay(): void {
  stopAutoPlay(false);
  // A finished game has nothing left to demo: start over (the battle is already
  // decided, so no reset confirmation applies).
  if (session.state === "over") submitAuto("reset");
  appendChunk(buildLinesChunkWith("banner", i18n("autoPlay.started")));
  scrollToBottom();
  resetAutoplayState(session);
  autoStuckPrompt = null;
  autoStuckCount = 0;
  autoPlayTimer = setInterval(() => {
    try {
      const command = nextAutoPlayCommand(session);
      if (command === null) {
        stopAutoPlay(true);
        return;
      }
      submitAuto(command);
    } catch (e) {
      stopAutoPlay(false);
      printError(`autoplay: ${errorMessage(e)}`);
    }
  }, AUTOPLAY_INTERVAL_MS);
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Insert") {
    // No overtype mode in the CLI: keep Insert from swapping in a block caret.
    e.preventDefault();
    return;
  }
  if (e.key === "Enter") {
    if (input.value.trim().toLowerCase() === "autoplay") {
      const echoed = `${promptBody(session)} > autoplay`;
      const echo = document.createElement("div");
      echo.className = "cmd";
      echo.textContent = echoed;
      out.insertBefore(echo, inrow);
      input.value = "";
      refreshPrompt();
      scrollToBottom();
      startAutoPlay();
    } else {
      submitInput(input.value);
    }
  } else if (e.key === "ArrowUp") {
    if (history.length > 0 && historyIdx > 0) {
      if (historyIdx === history.length) historyDraft = input.value;
      historyIdx -= 1;
      input.value = history[historyIdx] ?? "";
      scrollToBottom();
    }
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    if (historyIdx < history.length) {
      historyIdx += 1;
      input.value = history[historyIdx] ?? historyDraft;
      scrollToBottom();
    }
    e.preventDefault();
  }
});

input.addEventListener("input", scrollToBottom);

// MOTD: the header button opens a modal <dialog> over the terminal; ✕, Esc or
// a click on the backdrop closes it and hands focus back to the prompt. A dot
// on the button marks text this browser has not opened yet (hash kept in
// localStorage, every access guarded like the locale above).
const MOTD_SEEN_KEY = "bt10x.motd.seen";
const motdDialog = document.getElementById("motd") as HTMLDialogElement | null;
const motdOpen = document.getElementById("motd-open") as HTMLButtonElement | null;
const motdClose = document.getElementById("motd-close") as HTMLButtonElement | null;
const motdDot = document.getElementById("motd-dot");

function motdHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const motdVersion = motdHash(motdText);
let motdSeen: string | null = null;
try {
  motdSeen = localStorage.getItem(MOTD_SEEN_KEY);
} catch {
  // storage unavailable: the MOTD just always counts as unread
}
if (motdDot) motdDot.hidden = motdSeen === motdVersion;

if (motdDialog && motdOpen) {
  motdOpen.addEventListener("click", () => {
    if (motdDialog.open) return;
    motdClose?.setAttribute("aria-label", i18n("motd.close"));
    motdDialog.showModal();
    motdOpen.setAttribute("aria-expanded", "true");
    if (motdDot) motdDot.hidden = true;
    try {
      localStorage.setItem(MOTD_SEEN_KEY, motdVersion);
    } catch {
      // storage unavailable: the dot comes back next visit
    }
  });
  motdClose?.addEventListener("click", () => motdDialog.close());
  // A click whose target is the dialog itself but lands outside its box hit
  // the ::backdrop.
  motdDialog.addEventListener("click", (e) => {
    if (e.target !== motdDialog) return;
    const r = motdDialog.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) motdDialog.close();
  });
  motdDialog.addEventListener("close", () => {
    motdOpen.setAttribute("aria-expanded", "false");
    input.focus();
  });
}

// A battle lives only in memory: ask before a reload, close or Back throws it
// away. Autoplay demos are disposable and leave freely.
window.addEventListener("beforeunload", (e) => {
  if (session.state !== "battle" || autoPlayTimer !== null) return;
  e.preventDefault();
});

// Refocus the input on clicks inside the terminal, except when the click is a
// drag-selection (text copy) or lands in the scrollbar gutter — either would
// otherwise yank the view back to the bottom via input.focus().
let mouseDownAt: { x: number; y: number } | null = null;

document.getElementById("term")?.addEventListener("mousedown", (e) => {
  mouseDownAt = { x: e.clientX, y: e.clientY };
});

document.getElementById("term")?.addEventListener("click", (e) => {
  const start = mouseDownAt;
  mouseDownAt = null;
  if (start && (Math.abs(e.clientX - start.x) > 3 || Math.abs(e.clientY - start.y) > 3)) return;
  if ((e.target as Element | null)?.closest(".no-prompt-focus") != null) return;
  const rect = out.getBoundingClientRect();
  const scrollbar = out.offsetWidth - out.clientWidth;
  if (scrollbar > 0 && e.clientX >= rect.right - scrollbar) return;
  input.focus();
});

appendChunk(
  buildLinesChunkWith(
    "banner",
    i18n("app.banner.title", { version: VERSION }),
    i18n("app.banner.help"),
  ),
);

// The only async step: obtain the catalog packs once, then everything runs
// synchronously from the in-memory store (sheets decode + register on demand).
// The base pack (`btlib10x.jsonl`) is required; the SW season pack
// (`btlib10x.sw.jsonl`) degrades to a warning line when unavailable. The
// standalone single-file build embeds the catalogs in
// <script type="text/plain" id="bt10x-catalog"> (+ `-sw`) tags (see
// scripts/standalone-web.mjs); the multi-file build fetches the sibling files.
function embeddedCatalogText(id: string): string | null {
  const el = document.getElementById(id);
  const text = el?.textContent;
  // The engine keeps the lines it needs (see loadCatalog); drop the DOM copy
  // now so the catalog text isn't retained twice.
  el?.remove();
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function fetchCatalogText(file: string): Promise<string> {
  const fetchOnce = (): Promise<string> =>
    fetch(file).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
  // One retry rides out a transient network error.
  return fetchOnce().catch(fetchOnce);
}

function loadCatalogText(id: string, file: string): Promise<string> {
  // Scoped (not a module-level const) so the full text is GC-able once
  // the catalog has split out the lines it keeps.
  const embedded = embeddedCatalogText(id);
  if (embedded !== null) return Promise.resolve(embedded);
  return fetchCatalogText(file);
}
input.disabled = true;
// Until the catalog is in, the (disabled) prompt itself says so.
promptEl.textContent = `${i18n("app.catalog.loading")} `;
void loadCatalogText("bt10x-catalog", "btlib10x.jsonl")
  .then((text) => {
    const manifest = loadCatalog(text);
    for (const m of manifest.maps) {
      ensureMapRegistered(m.name);
    }
    return loadCatalogText("bt10x-catalog-sw", "btlib10x.sw.jsonl").then(
      (swText) => {
        const warnings: string[] = [];
        const sw = appendCatalog(swText, "sw", (message) => {
          warnings.push(message);
        });
        for (const m of sw.maps) {
          ensureMapRegistered(m.name);
        }
        return warnings;
      },
      (err: unknown) => [
        i18n("app.catalog.packFailed", {
          pack: "sw",
          error: err instanceof Error ? err.message : String(err),
        }),
      ],
    );
  })
  .then((warnings: string[]) => {
    if (warnings.length > 0) {
      appendChunk(
        buildCollapsibleChunk(
          i18n("app.catalog.warnSummary", { count: warnings.length }),
          warnings.map((w) => buildLinesChunkWith("banner", w)),
        ),
      );
    }
    input.disabled = false;
    input.focus();
    refreshPrompt();
  })
  .catch((err: unknown) => {
    promptEl.textContent = "";
    const errorMsg = i18n("app.catalog.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    appendChunk(
      buildCollapsibleChunk(i18n("app.catalog.errorSummary", { count: 1 }), [
        buildLinesChunkWith("banner", errorMsg),
      ]),
    );
    scrollToBottom();
  });
