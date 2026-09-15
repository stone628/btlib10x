import { VERSION } from "btlib10x";
import {
  AUTOPLAY_INTERVAL_MS,
  flushAutoPlayCommand,
  nextAutoPlayCommand,
  resetAutoplayState,
} from "./autoplay.js";
import { runChunks } from "./cli.js";
import { buildLinesChunk, type Chunk } from "./format.js";
import { i18n, isLocale } from "./i18n/index.js";
import motdText from "./MOTD.txt";
import * as S from "./session.js";

document.title = `bt10x terminal v${VERSION}`;

const out = document.getElementById("out") as HTMLDivElement;
const inrow = document.getElementById("inrow") as HTMLDivElement;
const promptEl = document.getElementById("prompt") as HTMLSpanElement;
const input = document.getElementById("cmd") as HTMLInputElement;

const session = S.newSession(42);

const modeHint = document.createElement("div");
modeHint.id = "modehint";
out.insertBefore(modeHint, inrow);
const urlLang = new URLSearchParams(window.location.search).get("lang");
if (urlLang !== null && isLocale(urlLang)) {
  session.locale = urlLang;
}

const motdBody = document.getElementById("motd-body");
if (motdBody) motdBody.innerHTML = motdText;

const history: string[] = [];
let historyIdx = -1;

function scrollToBottom(): void {
  out.scrollTop = out.scrollHeight;
}

function appendChunk(chunk: Chunk, parent: HTMLElement = out): void {
  const kind = chunk.kind;
  const insert = (el: Node): void => {
    if (parent === out) out.insertBefore(el, inrow);
    else parent.append(el);
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
  promptEl.textContent = `${S.promptBody(session)} > `;
  modeHint.textContent = S.moveModesHint(session) ?? "";
}

function submitImpl(raw: string) {
  const line = raw.trim();
  const echoed = `${S.promptBody(session)} > ${raw}`;
  const echo = document.createElement("div");
  echo.className = "cmd";
  echo.textContent = echoed;
  out.insertBefore(echo, inrow);
  if (line.length > 0) {
    history.push(line);
    historyIdx = history.length;
  }
  for (const chunk of runChunks(session, line)) {
    appendChunk(chunk);
  }
}

function submitEpilog() {
  input.value = "";
  refreshPrompt();
  scrollToBottom();
}

function submitAuto(raw: string): void {
  submitImpl(raw);
  submitEpilog();
}

function submitInput(raw: string) {
  stopAutoPlay(false);
  submitImpl(raw);
  submitEpilog();
}

// --- autoplay demo driver (hidden 'autoplay' command) ---

let autoPlayTimer: number | null = null;

function stopAutoPlay(finished: boolean): void {
  if (autoPlayTimer === null) return;
  clearInterval(autoPlayTimer);
  autoPlayTimer = null;
  if (finished) {
    appendChunk(buildLinesChunk([i18n(session.locale, "autoPlay.done")], "banner"));
    refreshPrompt();
  }
}

function startAutoPlay(): void {
  stopAutoPlay(false);
  appendChunk(buildLinesChunk([i18n(session.locale, "autoPlay.started")], "banner"));
  scrollToBottom();
  resetAutoplayState(session);
  autoPlayTimer = setInterval(() => {
    if (autoPlayTimer === null) {
      // flush remaining nextAutoPlayCommand
      const flushed = flushAutoPlayCommand();
      for (const cmd of flushed) submitImpl(cmd);
      submitEpilog();
      return;
    }
    const command = nextAutoPlayCommand(session);
    if (command === null) {
      stopAutoPlay(true);
      return;
    }
    submitAuto(command);
  }, AUTOPLAY_INTERVAL_MS);
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (input.value.trim() === "autoplay") {
      const echoed = `${S.promptBody(session)} > autoplay`;
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
      historyIdx -= 1;
      input.value = history[historyIdx] ?? "";
      scrollToBottom();
    }
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    if (historyIdx < history.length) {
      historyIdx += 1;
      input.value = history[historyIdx] ?? "";
      scrollToBottom();
    }
    e.preventDefault();
  }
});

input.addEventListener("input", scrollToBottom);

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
  buildLinesChunk(
    [
      i18n(session.locale, "app.banner.title", { version: VERSION }),
      i18n(session.locale, "app.banner.help"),
    ],
    "banner",
  ),
);
refreshPrompt();
