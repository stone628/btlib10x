/**
 * Application state shared by every screen. Screens are TUI prefabs that read
 * this object; any change calls `rerender()`, which updates the mounted scene.
 */
import type { Facing, HexCoord, UnitPolicy } from "btlib10x";
import type { BattleController } from "./battle/controller";
import type { Edge, RollOff } from "./battle/deploy";
import type { MapView } from "./map/view";
import type { Loadout, MechFilter } from "./setup/loadout";

export type ScreenId = "loading" | "title" | "setup" | "deploy" | "battle" | "debrief";
export type AiPace = "instant" | "step" | "timed";
export const AI_PACES: readonly AiPace[] = ["instant", "step", "timed"];
const PACE_KEY = "bt10x.instant.pace";
const REASONING_KEY = "bt10x.instant.reasoning";

/** Persona pace kept between visits (New Battle and the battle menu); "step" by default. */
function loadPace(): AiPace {
  try {
    const v = localStorage.getItem(PACE_KEY);
    return AI_PACES.find((p) => p === v) ?? "step";
  } catch {
    return "step";
  }
}

export function setAiPace(p: AiPace): void {
  app.aiPace = p;
  try {
    localStorage.setItem(PACE_KEY, p);
  } catch {
    // private mode or blocked storage: the pace lasts for this visit
  }
}

/** Persona reasoning log kept between visits (Options); off by default. */
function loadReasoning(): boolean {
  try {
    return localStorage.getItem(REASONING_KEY) === "on";
  } catch {
    return false;
  }
}

export function setAiReasoning(on: boolean): void {
  app.aiReasoning = on;
  try {
    localStorage.setItem(REASONING_KEY, on ? "on" : "off");
  } catch {
    // private mode or blocked storage: the setting lasts for this visit
  }
}

export interface Placement {
  hex: HexCoord;
  facing: Facing;
}

export interface DeployState {
  roll: RollOff;
  edges: [Edge | null, Edge | null];
  placements: Record<string, Placement>;
  /** Index into the unit list (any unit; only Player units can be moved or turned). */
  cursor: number;
  /** Focus the selected unit's button after the next render (keys and map picks). */
  focusUnit: boolean;
}

export type Modal =
  | {
      kind: "mech";
      side: 0 | 1;
      index: number;
      filter: MechFilter;
      /** Index into the filtered list. */
      cursor: number;
      /** Bring the cursor row into view after the next render (keyboard moves). */
      reveal: boolean;
      /** Give the cursor row the focus after the next render (opening, list keys). */
      focusList: boolean;
    }
  | {
      kind: "persona";
      side: 0 | 1;
      index: number;
      /** Index into the control list: 0 Player, then `PERSONA_KEYS`. */
      cursor: number;
      /** Give the cursor row the focus after the next render (opening, list keys). */
      focusList: boolean;
    }
  | {
      kind: "input";
      title: string;
      label: string;
      value: string;
      cols: number;
      error: string | null;
      /** Applies the value; returns an error message to keep the dialog open. */
      apply: (value: string) => string | null;
    }
  | {
      kind: "policy";
      /** Unit id for the title. */
      id: string;
      draft: UnitPolicy;
      /** Takes the edited policy on OK. */
      apply: (p: UnitPolicy) => void;
      /** The window OK / Cancel go back to (the battle menu it was opened from); none = close. */
      back?: Modal;
    }
  | { kind: "battleMenu"; cursor: number }
  | AttackDialog
  | { kind: "debriefMenu"; cursor: number }
  | { kind: "message"; title: string; text: string }
  | { kind: "menu"; title: string; items: readonly MenuItem[]; cursor: number }
  | {
      kind: "options";
      cursor: number;
      /** The window closing goes back to (the Esc menu it was opened from); null = none. */
      back: Modal | null;
    };

/**
 * An Esc menu entry (New Battle, deployment): label, action, keep the
 * menu open, a separator line above it.
 */
export interface MenuItem {
  readonly label: () => string;
  readonly run: () => void;
  readonly keep?: boolean;
  readonly sepAbove?: boolean;
}

/** One row of the Attack Command panel (`battle.attack.ts`). */
export type AttackPanelRow = "twist" | "target" | "weapons" | "physical" | "club";

/** The weapon or physical check-box dialog; `cursor` is its row, -1 when none can be checked. */
export interface AttackDialog {
  kind: "fire" | "physical";
  cursor: number;
}

/** One record-sheet drawer of the battle screen (left or right edge). */
export interface SheetDrawer {
  open: boolean;
  /** Last unit shown; kept while closed. Null until first opened. */
  unitId: string | null;
  /** Pinned: the phase policy (`sheetPolicy`) leaves this drawer as it is. */
  pinned: boolean;
}

/** Battle screen drawers and the Action Order strip's scroll position. */
export interface BattleUi {
  sheets: [SheetDrawer, SheetDrawer];
  logs: boolean;
  /** Action Order (ids and states) the scroll was last centred for; a change re-centres it. */
  queueFor: string | null;
  /** Turn, phase and actor the sheet policy last opened the drawers for. */
  sheetFor: string | null;
  /** Attack target the sheet policy last showed in the right drawer. */
  sheetTarget: string | null;
  /** Turn, actor and attack target the map last framed. */
  frameFor: string | null;
  /** Drawer open states hidden by the LOGS drawer, restored when it closes. */
  logSheets: [boolean, boolean] | null;
  /** Turn and mover the map last fitted (`centerPending`). */
  focusFor: string | null;
  /** Fit the mover and its enemies on the map after the next render. */
  centerPending: boolean;
  /** Frame the actor and its target on the map after the next render. */
  framePending: boolean;
  /** Size of the orders box over the map (cells), null when there is none. */
  menuBox: { cols: number; rows: number } | null;
  /** Key focus (Tab / X): the left sheet or its tab, the orders panel, the right sheet or tab. */
  focus: BattleFocus;
  /** Hint target (`data-hint`) the focused sheet's cursor sits on; null = its first. */
  hint: string | null;
  /** Attack panel row under the cursor, for the turn and actor `for`; null = the default. */
  attackRow: { for: string; row: AttackPanelRow } | null;
}

export type BattleFocus = 0 | "orders" | 1;

export function newBattleUi(): BattleUi {
  return {
    sheets: [
      { open: false, unitId: null, pinned: false },
      { open: false, unitId: null, pinned: false },
    ],
    logs: false,
    queueFor: null,
    sheetFor: null,
    sheetTarget: null,
    frameFor: null,
    logSheets: null,
    focusFor: null,
    centerPending: false,
    framePending: false,
    menuBox: null,
    focus: "orders",
    hint: null,
    attackRow: null,
  };
}

export interface App {
  screen: ScreenId;
  loadout: Loadout;
  /** Debrief tab. */
  tab: number;
  /** Debrief unit cursor (Units and Fires tabs), in roster order. */
  debriefUnit: number;
  cursors: { title: number };
  modal: Modal | null;
  deploy: DeployState | null;
  battle: BattleController | null;
  /** Battle Orders cursor (movement choices or attack rows). */
  orderCursor: number;
  battleUi: BattleUi;
  aiPace: AiPace;
  aiReasoning: boolean;
  /** Persistent map views: battle board and setup / deploy preview. */
  mapView: MapView | null;
  error: string | null;
  version: string;
  /** When control last passed from a persona to the Player (ms, `performance.now`). */
  playerSince: number;
  /** The last input came from the pad: the battle status bar shows its buttons. */
  padInput: boolean;
}

export const app: App = {
  screen: "loading",
  loadout: { sides: [[], []], map: null, mode: null, seed: 42 },
  tab: 0,
  debriefUnit: 0,
  cursors: { title: 0 },
  modal: null,
  deploy: null,
  battle: null,
  orderCursor: 0,
  battleUi: newBattleUi(),
  aiPace: loadPace(),
  aiReasoning: loadReasoning(),
  mapView: null,
  error: null,
  version: "",
  playerSince: 0,
  padInput: false,
};

/** True while a kit popup or dialog owns the keyboard (cleared after it resolves). */
export const kitModal = { open: false };

let rerenderFn: () => void = () => {};

export function setRerender(fn: () => void): void {
  rerenderFn = fn;
}

export function rerender(): void {
  rerenderFn();
}
