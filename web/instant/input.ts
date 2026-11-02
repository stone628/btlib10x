/**
 * Input scheme (docs/INSTANT.md "Controls"): one set of keys, with an Xbox
 * pad as their twin. The pad is polled each animation frame through the
 * Gamepad API (standard mapping). Its buttons become the scheme's keys,
 * dispatched as keydown events on the focused element, so every screen, kit
 * popup and dialog takes them as typed keys. Its sticks drive the map view
 * directly: the left one pans under the centre reticle, the right one turns
 * and tilts. Also here: the keyboard aliases and map keys shared by all
 * screens (Shift+Enter / Shift+Space = F10, Shift+arrows pan under the
 * reticle, Shift+PgUp / Shift+PgDn turn the map, PgUp / PgDn zoom a map
 * screen or scroll the battle log, Home frames the map).
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

/** A persona waits in step pace: A (Enter) plays its activation, even on the reticle. */
function stepping(): boolean {
  const b = app.battle;
  return (
    app.screen === "battle" && !!b && b.actorPersona !== null && app.aiPace === "step" && !b.result
  );
}

/**
 * Home (R3): the screen's own framing (battle: the units the prompt is
 * about), and the whole map on the next press; a pan starts over.
 */
function frameOrFit(v: NonNullable<ReturnType<typeof activeMap>>): void {
  if (v.reframe && !v.framed) {
    v.reframe();
    v.framed = true;
  } else {
    v.fit();
    v.framed = false;
  }
}

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
 * Map keys taken before the screen's own: Shift+arrows pan under the reticle
 * (`holdArrow`), a plain arrow hands A back to the screen (the reticle
 * hides), A on a showing reticle is a click there (not while a persona waits
 * in step pace), Shift+PgUp / Shift+PgDn turn the map (`holdTurn`), PgUp /
 * PgDn zoom (with the battle log open, scroll it), Home frames the map. True
 * when taken.
 */
export function mapKey(e: KeyboardEvent): boolean {
  const v = activeMap();
  if (!v) return false;
  const step = STEPS[e.key];
  if (step && e.shiftKey) {
    holdArrow(e.key, step);
    return true;
  }
  if (step) {
    v.hideReticle();
    return false;
  }
  if ((e.key === "PageUp" || e.key === "PageDown") && e.shiftKey) {
    holdTurn(e.key, e.key === "PageUp" ? 1 : -1);
    return true;
  }
  if (e.key === "PageUp" || e.key === "PageDown") {
    const log =
      app.screen === "battle" && app.battleUi.logs
        ? document.querySelector<HTMLElement>("#app .ia-logscroll")
        : null;
    const dir = e.key === "PageUp" ? -1 : 1;
    if (log) {
      log.scrollTop += dir * Math.round(log.clientHeight * 0.9);
      // the render after this key must not snap the log back to its end
      log.dataset.pinned = String(log.scrollTop + log.clientHeight >= log.scrollHeight - 4);
    } else v.zoom(-2 * dir);
    return true;
  }
  if (e.key === "Home") {
    frameOrFit(v);
    return true;
  }
  if (v.reticle && (e.key === "Enter" || e.key === " ") && !stepping()) {
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
  if (key === "Enter" && el.matches("button:not([data-commit]), .tui-tab")) el.click();
  else if (key === "Tab") stepFocus(1);
}

/**
 * Tab / Shift+Tab (X) that no screen took: move the focus through the open
 * dialog's controls, else the app's, wrapping round, so it never leaves for
 * the page header.
 */
export function stepFocus(dir: number): void {
  const all = focusables();
  if (all.length === 0) return;
  const i = all.indexOf(document.activeElement as HTMLElement);
  const from = i < 0 ? (dir > 0 ? -1 : 0) : i;
  all[(((from + dir) % all.length) + all.length) % all.length]!.focus();
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
  app.padInput = true;
  if (i === L3 || i === R3) {
    const v = activeMap();
    if (i === L3) v?.snapTurn();
    else if (v) frameOrFit(v);
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

/**
 * Listen for a pad; any mouse movement hides the reticle again. A typed key
 * or the mouse ends pad labels in the status bar; a released arrow, PgUp /
 * PgDn or Shift ends a Shift+arrow pan or a Shift+PgUp / PgDn turn.
 */
export function initInput(): void {
  window.addEventListener("gamepadconnected", start);
  if (Array.from(navigator.getGamepads?.() ?? []).some((p) => p?.connected)) start();
  document.addEventListener("mousemove", (e) => {
    if (!e.movementX && !e.movementY) return;
    app.mapView?.hideReticle();
    app.padInput = false;
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.isTrusted) app.padInput = false;
    },
    true,
  );
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift") {
      arrows.clear();
      turns.clear();
    } else {
      arrows.delete(e.key);
      turns.delete(e.key);
    }
  });
  window.addEventListener("blur", () => {
    arrows.clear();
    turns.clear();
  });
}

// ------------------------------------------------------------ Shift+arrow pan

/**
 * Shift+arrows run the reticle like a platform game hero: no jump on the
 * press, it sets off at PAN_START and speeds up (slowly at first, then
 * faster) to the stick's top speed over PAN_RAMP, so a tap moves it a few
 * pixels; let go, it skids to a stop over PAN_STOP. Two arrows held go
 * diagonally. Driven by keydown / keyup on animation frames, not by key
 * repeat.
 */
const PAN_START = 40;
const PAN_RAMP = 1000;
const PAN_STOP = 0.15;
const arrows = new Map<string, readonly [number, number]>();
let heldSince = 0;
let panLast = 0;
let panSpeed = 0;
let panDir: readonly [number, number] = [0, 0];
let panLoop = false;

function holdArrow(key: string, step: readonly [number, number]): void {
  if (arrows.has(key)) return; // key repeat: the pan loop already runs
  const v = activeMap();
  if (!v) return;
  if (arrows.size === 0) {
    v.showReticle();
    heldSince = performance.now();
  }
  arrows.set(key, step);
  if (panLoop) return;
  panLoop = true;
  panLast = 0;
  requestAnimationFrame(panFrame);
}

function panFrame(now: number): void {
  const v = activeMap();
  const dt = panLast ? Math.min(0.1, (now - panLast) / 1000) : 0;
  panLast = now;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of arrows.values()) {
    dx += x;
    dy += y;
  }
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    panDir = [dx / len, dy / len];
    const ramp = Math.min(1, (now - heldSince) / PAN_RAMP);
    panSpeed = PAN_START + (PAN_SPEED - PAN_START) * ramp * ramp;
  } else panSpeed = Math.max(0, panSpeed - (PAN_SPEED * dt) / PAN_STOP);
  if (!v || (len === 0 && panSpeed === 0)) {
    panLoop = false;
    panSpeed = 0;
    if (!v) arrows.clear();
    return;
  }
  if (panSpeed > 0 && dt > 0) {
    v.showReticle();
    v.panBy(panDir[0] * panSpeed * dt, panDir[1] * panSpeed * dt);
  }
  requestAnimationFrame(panFrame);
}

// ------------------------------------------------------------ Shift+PgUp / PgDn turn

/**
 * Shift+PgUp turns the map counter-clockwise, Shift+PgDn clockwise, with the
 * pan's feel: it sets off at TURN_START and speeds up to the stick's top
 * speed over PAN_RAMP, so a tap turns it a degree or two; let go, it slows to
 * a stop over PAN_STOP. Both held cancel out.
 */
const TURN_START = 8;
const turns = new Map<string, number>();
let turnSince = 0;
let turnLast = 0;
let turnSpeed = 0;
let turnDir = 0;
let turnLoop = false;

function holdTurn(key: string, dir: number): void {
  if (turns.has(key)) return; // key repeat: the turn loop already runs
  if (!activeMap()) return;
  if (turns.size === 0) turnSince = performance.now();
  turns.set(key, dir);
  if (turnLoop) return;
  turnLoop = true;
  turnLast = 0;
  requestAnimationFrame(turnFrame);
}

function turnFrame(now: number): void {
  const v = activeMap();
  const dt = turnLast ? Math.min(0.1, (now - turnLast) / 1000) : 0;
  turnLast = now;
  let dir = 0;
  for (const d of turns.values()) dir += d;
  if (dir !== 0) {
    turnDir = dir;
    const ramp = Math.min(1, (now - turnSince) / PAN_RAMP);
    turnSpeed = TURN_START + (TURN_SPEED - TURN_START) * ramp * ramp;
  } else turnSpeed = Math.max(0, turnSpeed - (TURN_SPEED * dt) / PAN_STOP);
  if (!v || (turns.size === 0 && turnSpeed === 0)) {
    turnLoop = false;
    turnSpeed = 0;
    if (!v) turns.clear();
    return;
  }
  if (turnSpeed > 0 && dt > 0) v.turn(turnDir * turnSpeed * dt);
  requestAnimationFrame(turnFrame);
}
