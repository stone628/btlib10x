import * as S from "./session.js";
import { execute } from "./cli.js";
import { t } from "./i18n/index.js";

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

function appendLines(lines: readonly string[], cls?: string): void {
  if (lines.length === 0) return;
  if (lines.length === 1 && lines[0] === "\f") {
    out.replaceChildren(inrow);
    // Re-parenting the input blurs it; restore focus so the caret stays live.
    input.focus();
    return;
  }
  const div = document.createElement("div");
  div.className = cls ?? "";
  div.textContent = lines.join("\n");
  out.insertBefore(div, inrow);
  scrollToBottom();
}

function refreshPrompt(): void {
  promptEl.textContent = `${S.promptBody(session)} > `;
}

function submit(raw: string): void {
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
  const isErr = (l: string): boolean => l.startsWith("error:");
  for (const chunk of classify(execute(session, line))) {
    appendLines(chunk.lines, chunk.cls);
  }
  input.value = "";
  refreshPrompt();
  scrollToBottom();

  function classify(lines: readonly string[]): { lines: string[]; cls: string }[] {
    return [
      {
        lines: lines.filter((l) => !isErr(l) && !l.startsWith("===")),
        cls: "",
      },
      { lines: lines.filter(isErr), cls: "err" },
      { lines: lines.filter((l) => l.startsWith("===")), cls: "banner" },
    ];
  }
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    submit(input.value);
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

appendLines(
  [t(session.locale, "app.banner.title"), t(session.locale, "app.banner.help")],
  "banner",
);
refreshPrompt();
