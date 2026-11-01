/**
 * Input scheme (docs/INSTANT.md "Controls"): one set of keys, with an Xbox
 * pad as their twin. The pad is polled each animation frame through the
 * Gamepad API (standard mapping). Its buttons become the scheme's keys,
 * dispatched as keydown events on the focused element, so every screen, kit
 * popup and dialog takes them as typed keys. Its sticks drive the map view
 * directly: the left one pans under the centre reticle, the right one turns
 * and tilts. Also here: the keyboard aliases and map keys shared by all
 * screens (Shift+Enter / Shift+Space = F10, Shift+arrows move the reticle,
 * PgUp / PgDn zoom a map screen).
 */
import { app, kitModal } from "./state";

/** Standard-mapping button → [key, code]; L3 and R3 act on the map instead. */
const BUTTON_KEYS: readonly (readonly [string, string] | null)[] = [
  ["Enter", "Enter"], // A
  ["Backspace", "Backspace"], // B
  ["Tab", "Tab"], // X
  ["F10", "F10"], // Y
  ["[", "BracketLeft"], // LB
  ["]", "BracketRight"], // RB
  ["PageUp", "PageUp"], // LT
  ["PageDown", "PageDown"], // RT
  ["l", "KeyL"], // View
  ["Escape", "Escape"], // Menu
  null, // L3: snap / turn the map
  null, // R3: fit the map
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
];
const L3 = 10;
const R3 = 11;
/** Buttons that repeat while held (D-pad, triggers): first after 400 ms, then every 80 ms. */
const REPEATS = new Set([6, 7, 12, 13, 14, 15]);
const REPEAT_FIRST = 400;
const REPEAT_NEXT = 80;
const DEADZONE = 0.2;
/** Full-stick map speeds: pan in CSS px, turn and tilt in degrees, per second. */
const PAN_SPEED = 700;
const TURN_SPEED = 120;
const TILT_SPEED = 60;

/** The map under the sticks and map keys: battle, deployment, debrief Map tab. */
export function activeMap() {
  const v = app.mapView;
  const screen = app.screen === "battle" || app.screen === "deploy" || app.screen === "debrief";
  if (!v || !screen || !v.canvas.isConnected || app.modal || kitModal.open) return null;
  return v;
}

/**
 * Shift+Enter / Shift+Space are F10 (commit) outside text boxes. The stand-in
 * carries only what the screen handlers read (they never touch the event).
 */
export function commitAlias(e: KeyboardEvent): KeyboardEvent {
  if (!e.shiftKey || (e.key !== "Enter" && e.key !== " ")) return e;
  return { key: "F10", code: "F10", shiftKey: false, repeat: e.repeat } as KeyboardEvent;
}

/**
 * [ / ] (LB / RB) as -1 / +1, else 0. The key code covers layouts that type
 * another character there; the key covers events that carry no code.
 */
export function bracket(e: KeyboardEvent): number {
  if (e.code === "BracketLeft" || e.key === "[") return -1;
  if (e.code === "BracketRight" || e.key === "]") return 1;
  return 0;
}

/** L (View): the code under a Hangul IME, the key without a code. */
export function isLogsKey(e: KeyboardEvent): boolean {
  return e.code === "KeyL" || e.key === "l" || e.key === "L";
}

const STEPS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Map keys taken before the screen's own: Shift+arrows step the reticle, a
 * plain arrow hands A back to the screen (the reticle hides), A on a showing
 * reticle is a click there, PgUp / PgDn zoom. True when taken.
 */
export function mapKey(e: KeyboardEvent): boolean {
  const v = activeMap();
  if (!v) return false;
  const step = STEPS[e.key];
  if (step && e.shiftKey) {
    v.stepReticle(step[0], step[1]);
    return true;
  }
  if (step) {
    v.hideReticle();
    return false;
  }
  if (e.key === "PageUp" || e.key === "PageDown") {
    v.zoom(e.key === "PageUp" ? 2 : -2);
    return true;
  }
  if (v.reticle && (e.key === "Enter" || e.key === " ")) {
    // the debrief map only looks: A there does nothing
    if (app.screen !== "debrief") v.pickReticle();
    return true;
  }
  return false;
}

// ------------------------------------------------------------ gamepad

/** Focusable controls of the open dialog, else of the app, in page order. */
function focusables(): HTMLElement[] {
  const scope =
    document.querySelector<HTMLElement>(".tui-dialog, #app .ia-modal") ??
    document.getElementById("app");
  if (!scope) return [];
  return Array.from(
    scope.querySelectorAll<HTMLElement>("button:not(:disabled), input:not([type=hidden])"),
  ).filter((el) => el.offsetParent !== null && el.tabIndex >= 0);
}

/** A pad button's key on the focused element; a synthetic key gets no browser default. */
function press(key: string, code: string, repeat: boolean): void {
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  // B leaves a text box (Backspace there would only delete)
  if (key === "Backspace" && el instanceof HTMLInputElement) {
    el.blur();
    return;
  }
  const ev = new KeyboardEvent("keydown", { key, code, repeat, bubbles: true, cancelable: true });
  if (!el.dispatchEvent(ev)) return;
  if (key === "Enter" && el.matches("button:not([data-commit]), [role=button], [role=tab]"))
    el.click();
  else if (key === "Tab") {
    const all = focusables();
    const i = all.indexOf(el);
    all[(i + 1) % Math.max(1, all.length)]?.focus();
  }
}

let held: boolean[] = [];
let nextRepeat: number[] = [];
let last = 0;
let tilt = 0;
let polling = false;

function poll(now: number): void {
  const pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p?.connected) ?? null;
  if (!pad) {
    polling = false;
    held = [];
    return;
  }
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  pad.buttons.forEach((b, i) => {
    const down = b.pressed || b.value > 0.5;
    const was = held[i] ?? false;
    held[i] = down;
    if (!down) return;
    if (!was) {
      nextRepeat[i] = now + REPEAT_FIRST;
      fire(i, false);
    } else if (REPEATS.has(i) && now >= (nextRepeat[i] ?? Infinity)) {
      nextRepeat[i] = now + REPEAT_NEXT;
      fire(i, true);
    }
  });
  sticks(pad, dt);
  requestAnimationFrame(poll);
}

function fire(i: number, repeat: boolean): void {
  if (i === L3 || i === R3) {
    const v = activeMap();
    if (i === L3) v?.snapTurn();
    else v?.fit();
    return;
  }
  const k = BUTTON_KEYS[i];
  if (k) press(k[0], k[1], repeat);
}

const axis = (v: number | undefined) => {
  const a = v ?? 0;
  return Math.abs(a) < DEADZONE ? 0 : (a - Math.sign(a) * DEADZONE) / (1 - DEADZONE);
};

function sticks(pad: Gamepad, dt: number): void {
  const v = activeMap();
  if (!v || dt === 0) return;
  const lx = axis(pad.axes[0]);
  const ly = axis(pad.axes[1]);
  if (lx || ly) {
    v.showReticle();
    v.panBy(lx * PAN_SPEED * dt, ly * PAN_SPEED * dt);
  }
  const rx = axis(pad.axes[2]);
  const ry = axis(pad.axes[3]);
  if (rx) v.turn(rx * TURN_SPEED * dt);
  // tilt moves in whole degrees (the indicator prints it); up is toward top-down
  tilt += -ry * TILT_SPEED * dt;
  if (!ry) tilt = 0;
  if (Math.abs(tilt) >= 1) {
    const whole = Math.trunc(tilt);
    tilt -= whole;
    v.tiltBy(whole);
  }
}

function start(): void {
  if (polling) return;
  polling = true;
  last = 0;
  held = [];
  nextRepeat = [];
  requestAnimationFrame(poll);
}

/** Listen for a pad; any mouse movement hides the reticle again. */
export function initInput(): void {
  window.addEventListener("gamepadconnected", start);
  if (Array.from(navigator.getGamepads?.() ?? []).some((p) => p?.connected)) start();
  document.addEventListener("mousemove", (e) => {
    if (e.movementX || e.movementY) app.mapView?.hideReticle();
  });
}
