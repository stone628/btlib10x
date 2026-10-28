/**
 * Application state shared by every screen. Screens are TUI prefabs that read
 * this object; any change calls `rerender()`, which updates the mounted scene.
 */
import type { ClubKind, Facing, HexCoord, PhysicalAttackDecl, UnitPolicy } from "btlib10x";
import type { BattleController } from "./battle/controller";
import type { Edge, RollOff } from "./battle/deploy";
import type { MapView } from "./map/view";
import type { Loadout, MechFilter } from "./setup/loadout";

export type ScreenId = "loading" | "title" | "setup" | "deploy" | "battle" | "debrief";
export type AiPace = "instant" | "step" | "timed";

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
  /** Edge button under the pointer while the winner chooses; tinted on the map. */
  hoverEdge: Edge | null;
  /** Edge the winner has selected; Proceed (F10) takes it. */
  pickedEdge: Edge | null;
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
    }
  | { kind: "battleMenu"; cursor: number }
  | { kind: "message"; title: string; text: string };

/** One row of the attack panel: a weapon, a physical attack, a club action. */
export type AttackRow =
  | { kind: "weapon"; weaponIndex: number; enabled: boolean }
  | { kind: "physical"; decl: PhysicalAttackDecl }
  | { kind: "pickup"; source: ClubKind }
  | { kind: "drop" };

/** One record-sheet drawer of the battle screen (left or right edge). */
export interface SheetDrawer {
  open: boolean;
  /** Last unit shown; kept while closed. Null until first opened. */
  unitId: string | null;
  /** Open order (higher = opened later); picks the drawer a queue click reuses. */
  openedAt: number;
}

/** Battle screen drawers and the Action Order strip's scroll position. */
export interface BattleUi {
  sheets: [SheetDrawer, SheetDrawer];
  logs: boolean;
  /** Actor the Action Order scroll was last fitted to; a new actor re-fits it. */
  queueFor: string | null;
  /** Actor and attack target whose sheet the right drawer last showed. */
  sheetTarget: string | null;
  /** Drawer open states hidden by the LOGS drawer, restored when it closes. */
  logSheets: [boolean, boolean] | null;
  /** Turn and unit the movement focus (left sheet, map centre) last went to. */
  focusFor: string | null;
  /** Fit the mover and its enemies on the map after the next render. */
  centerPending: boolean;
  /** Frame the actor and its target on the map after the next render. */
  framePending: boolean;
  /** Size of the orders box over the map (cells), null when there is none. */
  menuBox: { cols: number; rows: number } | null;
  /** Counter behind `SheetDrawer.openedAt`. */
  seq: number;
}

export function newBattleUi(): BattleUi {
  return {
    sheets: [
      { open: false, unitId: null, openedAt: 0 },
      { open: false, unitId: null, openedAt: 0 },
    ],
    logs: false,
    queueFor: null,
    sheetTarget: null,
    logSheets: null,
    focusFor: null,
    centerPending: false,
    framePending: false,
    menuBox: null,
    seq: 0,
  };
}

export interface App {
  screen: ScreenId;
  loadout: Loadout;
  /** Debrief tab. */
  tab: number;
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
}

export const app: App = {
  screen: "loading",
  loadout: { sides: [[], []], map: "quickstart", mode: { kind: "destroyAll" }, seed: 42 },
  tab: 0,
  cursors: { title: 0 },
  modal: null,
  deploy: null,
  battle: null,
  orderCursor: 0,
  battleUi: newBattleUi(),
  aiPace: "instant",
  aiReasoning: false,
  mapView: null,
  error: null,
  version: "",
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
