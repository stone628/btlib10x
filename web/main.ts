import * as S from "./session.js";
import { execute } from "./cli.js";
import { t } from "./i18n/index.js";

const out = document.getElementById("out") as HTMLDivElement;
const promptEl = document.getElementById("prompt") as HTMLSpanElement;
const input = document.getElementById("cmd") as HTMLInputElement;

const session = S.newSession(42);
const history: string[] = [];
let historyIdx = -1;

function appendLines(lines: readonly string[], cls?: string): void {
  if (lines.length === 0) return;
  if (lines.length === 1 && lines[0] === "\f") {
    out.replaceChildren();
    return;
  }
  const div = document.createElement("div");
  div.className = cls ?? "";
  div.textContent = lines.join("\n");
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

function refreshPrompt(): void {
  promptEl.textContent = `${S.promptBody(session)} > `;
}

function submit(raw: string): void {
  const line = raw.trim();
  const echoed = `${S.promptBody(session)} > ${line}`;
  if (line.length > 0) {
    history.push(line);
    historyIdx = history.length;
    const echo = document.createElement("div");
    echo.className = "cmd";
    echo.textContent = echoed;
    out.appendChild(echo);
  }
  const isErr = (l: string): boolean => l.startsWith("error:");
  for (const chunk of classify(execute(session, line))) {
    appendLines(chunk.lines, chunk.cls);
  }
  input.value = "";
  refreshPrompt();

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
  if (e.key === "Enter" && input.value.trim().length > 0) {
    submit(input.value);
  } else if (e.key === "ArrowUp") {
    if (history.length > 0 && historyIdx > 0) {
      historyIdx -= 1;
      input.value = history[historyIdx] ?? "";
    }
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    if (historyIdx < history.length) {
      historyIdx += 1;
      input.value = history[historyIdx] ?? "";
    }
    e.preventDefault();
  }
});

document.getElementById("term")?.addEventListener("click", () => input.focus());

appendLines(
  [t(session.locale, "app.banner.title"), t(session.locale, "app.banner.help")],
  "banner",
);
refreshPrompt();
