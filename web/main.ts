import type { CharStyle } from "../src/render.js";
import { AUTOPLAY_INTERVAL_MS, nextAutoPlayCommand } from "./autoplay.js";
import { runChunks } from "./cli.js";
import type { Chunk } from "./format.js";
import { t } from "./i18n/index.js";
import * as S from "./session.js";

const out = document.getElementById("out") as HTMLDivElement;
const inrow = document.getElementById("inrow") as HTMLDivElement;
const promptEl = document.getElementById("prompt") as HTMLSpanElement;
const input = document.getElementById("cmd") as HTMLInputElement;

const session = S.newSession(42);
const history: string[] = [];
let historyIdx = -1;

function scrollToBottom(): void {
  out.scrollTop = out.scrollHeight;
}

function styleClasses(style: CharStyle | undefined): string {
  if (style === undefined) return "";
  const parts: string[] = [];
  if (style.fg !== undefined) parts.push(`f-${style.fg}`);
  if (style.bg !== undefined) parts.push(`bg-${style.bg}`);
  if (style.bold === true) parts.push("b");
  if (style.italic === true) parts.push("i");
  if (style.cls !== undefined) parts.push(style.cls);
  return parts.join(" ");
}

function appendBoard(div: HTMLDivElement, board: Chunk & { board: readonly unknown[] }): void {
  const lines = board.board as ReadonlyArray<ReadonlyArray<{ text: string; style?: CharStyle }>>;
  lines.forEach((line, i) => {
    if (i > 0) div.append("\n");
    for (const sp of line) {
      const el = document.createElement("span");
      el.className = styleClasses(sp.style);
      el.textContent = sp.text;
      div.appendChild(el);
    }
  });
}

function appendChunk(chunk: Chunk): void {
  if ("board" in chunk) {
    const div = document.createElement("div");
    div.className = "board";
    appendBoard(div, chunk);
    out.insertBefore(div, inrow);
    scrollToBottom();
    return;
  }
  if (chunk.lines.length === 0) return;
  if (chunk.lines.length === 1 && chunk.lines[0] === "\f") {
    out.replaceChildren(inrow);
    // Re-parenting the input blurs it; restore focus so the caret stays live.
    input.focus();
    return;
  }
  const div = document.createElement("div");
  div.className = chunk.cls ?? "";
  div.textContent = chunk.lines.join("\n");
  out.insertBefore(div, inrow);
  scrollToBottom();
}

function refreshPrompt(): void {
  promptEl.textContent = `${S.promptBody(session)} > `;
}

function submit(raw: string, fromAutoPlay = false): void {
  if (!fromAutoPlay) stopAutoPlay(false);
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
  session.lastAutoPlayCmd = line;
  input.value = "";
  refreshPrompt();
  scrollToBottom();
}

// --- autoplay demo driver (hidden 'autoplay' command) ---

let autoPlayTimer: number | null = null;

function stopAutoPlay(finished: boolean): void {
  if (autoPlayTimer === null) return;
  clearInterval(autoPlayTimer);
  autoPlayTimer = null;
  if (finished) {
    appendChunk({ lines: [t(session.locale, "autoPlay.done")] });
    refreshPrompt();
  }
}

function startAutoPlay(): void {
  stopAutoPlay(false);
  appendChunk({ lines: [t(session.locale, "autoPlay.started")], cls: "banner" });
  scrollToBottom();
  autoPlayTimer = setInterval(() => {
    if (autoPlayTimer === null) return;
    const command = nextAutoPlayCommand(session);
    if (command === null) {
      stopAutoPlay(true);
      return;
    }
    submit(command, true);
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
      submit(input.value);
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
  const rect = out.getBoundingClientRect();
  const scrollbar = out.offsetWidth - out.clientWidth;
  if (scrollbar > 0 && e.clientX >= rect.right - scrollbar) return;
  input.focus();
});

appendChunk({
  lines: [t(session.locale, "app.banner.title"), t(session.locale, "app.banner.help")],
  cls: "banner",
});
refreshPrompt();
