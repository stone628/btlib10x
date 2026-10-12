import { ARMS, HEADS, LEGS, type PartVariant, SHOULDERS, TORSOS } from "./avatar.data";

interface PartDef {
  key: string;
  title: string;
  variants: PartVariant[];
}

const PARTS: PartDef[] = [
  { key: "head", title: "HEAD", variants: HEADS },
  { key: "shoulder", title: "SHOULDER", variants: SHOULDERS },
  { key: "torso", title: "TORSO", variants: TORSOS },
  { key: "arms", title: "ARMS", variants: ARMS },
  { key: "legs", title: "LEGS", variants: LEGS },
];

/** Default number of preview avatars shown on each side of the selected one. */
const SIDE_COUNT = 5;

/** Full-mech box with single borders (side previews). */
function composeAvatar(
  head: string,
  shoulder: string,
  torso: string,
  arm: string,
  leg: string,
): string[] {
  const sL = shoulder[0] ?? " ";
  const sR = shoulder[1] ?? " ";
  const h = `${head[0] ?? " "}${head[1] ?? " "}`;
  const aL = arm[0] ?? " ";
  const aR = arm[1] ?? " ";
  const t = `${torso[0] ?? " "}${torso[1] ?? " "}`;
  const lL = leg[0] ?? " ";
  const lR = leg[1] ?? " ";
  return ["┌────┐", `│${sL}${h}${sR}│`, `│${aL}${t}${aR}│`, `│ ${lL}${lR} │`, "└────┘"];
}

/** Full-mech box with double borders (selected center). */
export function composeSelectedAvatar(
  head: string,
  shoulder: string,
  torso: string,
  arm: string,
  leg: string,
): string[] {
  const sL = shoulder[0] ?? " ";
  const sR = shoulder[1] ?? " ";
  const h = `${head[0] ?? " "}${head[1] ?? " "}`;
  const aL = arm[0] ?? " ";
  const aR = arm[1] ?? " ";
  const t = `${torso[0] ?? " "}${torso[1] ?? " "}`;
  const lL = leg[0] ?? " ";
  const lR = leg[1] ?? " ";
  return ["╔════╗", `║${sL}${h}${sR}║`, `║${aL}${t}${aR}║`, `║ ${lL}${lR} ║`, "╚════╝"];
}

/**
 * How many side slots fit on each side of the selected box, given the
 * measured carousel row width, center (selected + step buttons) width, a
 * single side-slot width and the flex gap. Falls back to SIDE_COUNT when
 * the measurements are unusable (first paint, non-DOM contexts).
 */
function sideCountForWidth(
  rowWidth: number,
  midWidth: number,
  slotWidth: number,
  gap: number,
): number {
  const per = slotWidth + gap;
  if (!(slotWidth > 0) || !(rowWidth > 0)) return SIDE_COUNT;
  return Math.max(1, Math.floor((rowWidth - midWidth) / 2 / per));
}

/** Preview avatars shown on each side of the selected one; re-measured per viewport. */
let sideCount = SIDE_COUNT;

const STORAGE_KEY = "bt10x.avatar";

function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

interface AvatarState {
  idx: number[];
  active: number;
}

function loadState(): AvatarState {
  const idx = PARTS.map(() => 0);
  let active = 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { idx?: unknown; active?: unknown };
      if (Array.isArray(parsed.idx)) {
        for (let p = 0; p < PARTS.length; p++) {
          const v = parsed.idx[p];
          const n = PARTS[p]?.variants.length ?? 1;
          if (typeof v === "number" && Number.isInteger(v)) idx[p] = wrapIndex(v, n);
        }
      }
      if (typeof parsed.active === "number" && Number.isInteger(parsed.active)) {
        active = wrapIndex(parsed.active, PARTS.length);
      }
    }
  } catch {
    // Corrupt storage: fall back to defaults.
  }
  return { idx, active };
}

function saveState(state: AvatarState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ idx: state.idx, active: state.active }));
  } catch {
    // Storage may be blocked: the customizer still works in memory.
  }
}

const state: AvatarState = loadState();

const stage = document.getElementById("stage") as HTMLDivElement;
const exportEl = document.getElementById("export") as HTMLPreElement;
const partsEl = document.getElementById("parts") as HTMLDivElement;
const live = document.getElementById("sr-live") as HTMLDivElement;

function currentData(): {
  head: string;
  shoulder: string;
  torso: string;
  arm: string;
  leg: string;
} {
  return {
    head: PARTS[0]?.variants[state.idx[0] ?? 0]?.data ?? "  ",
    shoulder: PARTS[1]?.variants[state.idx[1] ?? 0]?.data ?? "  ",
    torso: PARTS[2]?.variants[state.idx[2] ?? 0]?.data ?? "  ",
    arm: PARTS[3]?.variants[state.idx[3] ?? 0]?.data ?? "  ",
    leg: PARTS[4]?.variants[state.idx[4] ?? 0]?.data ?? "  ",
  };
}

function avatarWithOverride(part: number, variant: number): string[] {
  const cur = currentData();
  const order = [cur.head, cur.shoulder, cur.torso, cur.arm, cur.leg] as string[];
  const def = PARTS[part];
  if (def !== undefined)
    order[part] =
      def.variants[wrapIndex(variant, def.variants.length)]?.data ?? order[part] ?? "  ";
  return composeAvatar(
    order[0] ?? "  ",
    order[1] ?? "  ",
    order[2] ?? "  ",
    order[3] ?? "  ",
    order[4] ?? "  ",
  );
}

function announce(): void {
  const def = PARTS[state.active];
  if (def === undefined) return;
  const v = def.variants[state.idx[state.active] ?? 0];
  if (v === undefined) return;
  live.textContent = `${def.title}: ${v.name}, ${v.desc}`;
}

/** Flex gap in `.carousel` (see avatar.css); kept in sync by hand. */
const CAROUSEL_GAP = 8;

/** Re-derive the side count from the rendered first row, or keep the current one. */
function measureSideCount(): number {
  const row = stage.querySelector(".carousel");
  const slot = stage.querySelector(".avatar.side");
  const mid = stage.querySelector(".mid");
  if (
    !(row instanceof HTMLElement) ||
    !(slot instanceof HTMLElement) ||
    !(mid instanceof HTMLElement)
  ) {
    return sideCount;
  }
  return sideCountForWidth(row.clientWidth, mid.offsetWidth, slot.offsetWidth, CAROUSEL_GAP);
}

/** Re-render only when the viewport fits a different number of side slots. */
function syncWidth(): void {
  const next = measureSideCount();
  if (next !== sideCount) {
    sideCount = next;
    render();
  }
}

function render(): void {
  stage.replaceChildren();
  const cur = currentData();
  const selected = composeSelectedAvatar(cur.head, cur.shoulder, cur.torso, cur.arm, cur.leg);

  PARTS.forEach((def, p) => {
    const n = def.variants.length;
    const sel = wrapIndex(state.idx[p] ?? 0, n);
    const variant = def.variants[sel];
    if (variant === undefined) return;

    const section = document.createElement("section");
    section.className = "part";
    if (p === state.active) section.classList.add("active");

    const label = document.createElement("div");
    label.className = "part-label";
    label.textContent = `[${def.title}: ${variant.name} — ${variant.desc}]`;
    section.append(label);

    const row = document.createElement("div");
    row.className = "carousel";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `${def.title} variants`);

    for (let off = -sideCount; off <= sideCount; off++) {
      if (off === 0) {
        const mid = document.createElement("div");
        mid.className = "mid";

        const prev = document.createElement("button");
        prev.type = "button";
        prev.className = "step";
        prev.textContent = "<";
        prev.setAttribute("aria-label", `previous ${def.title}`);
        prev.addEventListener("click", () => {
          state.idx[p] = wrapIndex(sel - 1, n);
          state.active = p;
          saveState(state);
          render();
          announce();
        });

        const box = document.createElement("button");
        box.type = "button";
        box.className = "avatar selected";
        const art = document.createElement("span");
        art.className = "art";
        art.textContent = selected.join("\n");
        const cap = document.createElement("span");
        cap.className = "cap";
        cap.setAttribute("aria-hidden", "true");
        cap.textContent = variant.name;
        box.append(art, cap);
        box.setAttribute("aria-label", `${def.title} ${variant.name} selected`);
        box.addEventListener("click", () => {
          state.active = p;
          saveState(state);
          render();
          announce();
        });

        const next = document.createElement("button");
        next.type = "button";
        next.className = "step";
        next.textContent = ">";
        next.setAttribute("aria-label", `next ${def.title}`);
        next.addEventListener("click", () => {
          state.idx[p] = wrapIndex(sel + 1, n);
          state.active = p;
          saveState(state);
          render();
          announce();
        });

        mid.append(prev, box, next);
        row.append(mid);
      } else {
        const vi = wrapIndex(sel + off, n);
        const lines = avatarWithOverride(p, vi);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "avatar side";
        const third = sideCount / 3;
        if (Math.abs(off) > third * 2) b.classList.add("far");
        else if (Math.abs(off) > third) b.classList.add("near");
        const target = def.variants[vi];
        const art = document.createElement("span");
        art.className = "art";
        art.textContent = lines.join("\n");
        const cap = document.createElement("span");
        cap.className = "cap";
        cap.setAttribute("aria-hidden", "true");
        cap.textContent = target?.name ?? "";
        b.append(art, cap);
        b.setAttribute("aria-label", `${def.title} ${target?.name ?? ""}`);
        b.title = target !== undefined ? `${target.name} — ${target.desc}` : "";
        b.addEventListener("click", () => {
          state.idx[p] = vi;
          state.active = p;
          saveState(state);
          render();
          announce();
        });
        row.append(b);
      }
    }

    section.append(row);
    stage.append(section);
  });

  const names = PARTS.map(
    (def, p) => `${def.title}=${def.variants[state.idx[p] ?? 0]?.name ?? "??"}`,
  ).join(" ");
  exportEl.textContent = selected.join("\n");
  partsEl.textContent = names;
}

function stepActive(delta: number): void {
  const def = PARTS[state.active];
  if (def === undefined) return;
  const n = def.variants.length;
  state.idx[state.active] = wrapIndex((state.idx[state.active] ?? 0) + delta, n);
  saveState(state);
  render();
  announce();
}

function moveActive(delta: number): void {
  state.active = wrapIndex(state.active + delta, PARTS.length);
  saveState(state);
  render();
  announce();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepActive(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stepActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  }
});

document.getElementById("copy")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      `${exportEl.textContent ?? ""}\n${partsEl.textContent ?? ""}`,
    );
    live.textContent = "avatar copied to clipboard";
  } catch {
    live.textContent = "copy failed: clipboard unavailable";
  }
});

document.getElementById("random")?.addEventListener("click", () => {
  PARTS.forEach((def, p) => {
    state.idx[p] = Math.floor(Math.random() * def.variants.length);
  });
  saveState(state);
  render();
  announce();
});

render();
syncWidth();

// Mono metrics settle after fonts load, which shifts the slot measurement.
void document.fonts.ready.then(() => {
  syncWidth();
});

let resizeQueued = false;
window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    syncWidth();
  });
});
