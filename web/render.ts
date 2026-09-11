// ---- Public facade over renderer.text.ts. ----
// All value-level imports flow one way (render.ts → renderer.text.ts); the
// reverse edge (renderer.text.ts → render.ts) is type-only and erased at
// compile time, so there is never a runtime module cycle.
import type { Facing, HexCoord, MapDef, RevealedLanding, UnitInit, UnitState } from "btlib10x";
import { cssGridRenderer, textRenderer } from "./renderer.text.js";

// ---- renderer supplier ----

/** Board renderer: populates a parent container from a {@link BoardRenderInfo}. */
export type BoardRenderer = (info: BoardRenderInfo, el: Element) => void;

const RENDERERS: Readonly<Record<string, BoardRenderer>> = {
  "css-grid": cssGridRenderer,
  text: textRenderer,
};

/** Return the named board renderer, or undefined if unknown. */
export function getBoardRenderer(name: string): BoardRenderer | undefined {
  return RENDERERS[name];
}

// ---- board render info (what a BoardRenderer consumes) ----

export interface BoardRenderUnit {
  readonly id: string;
  readonly team: number;
  readonly model: string;
  readonly position: HexCoord;
  readonly facing: Facing;
}

export function createBoardRenderUnit(unit: UnitState | UnitInit): BoardRenderUnit {
  return {
    id: unit.id,
    team: unit.team,
    model: unit.model,
    position: { ...unit.position },
    facing: unit.facing,
  };
}

/**
 * Everything the web layer needs to describe one board render. `map` always
 * supplies the board bounds and terrain; `units` (when non-null) places unit
 * ids/facings; `reachables` (when non-null) draws the reachable-hex overlay
 * and crops the model to the reachable bounding box, tinting markers and
 * edges with the acting unit's team (`reachableTeam`).
 */
export interface BoardRenderReachableInfo {
  readonly team: number;
  readonly revealed: RevealedLanding[];
}

export interface BoardRenderInfo {
  readonly map: MapDef;
  readonly units: BoardRenderUnit[] | null;
  readonly reachable: BoardRenderReachableInfo | null;
  /** Wreck marks keyed by hex `"col,row"` (glyph per hex), overriding the
   *  terrain mark in that hex. Usually `{"x,y": "X"}` per ejected 'Mech. */
  readonly wrecks?: Readonly<Record<string, string>>;
}
