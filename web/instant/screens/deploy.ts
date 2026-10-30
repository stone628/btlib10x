/**
 * Screen 2: deployment (TW p. 256 roll-off, home edges, placement). The map
 * takes clicks (choose an edge, place or select a unit, turn the selected
 * one); the side pane holds kit buttons. Persona units are placed by the
 * engine and cannot be moved or turned.
 */
import type { Facing, HexCoord } from "btlib10x";
import { PERSONAS } from "../ai/persona.data";
import { EDGES, type Edge, edgeHexes } from "../battle/deploy";
import {
  autoPlacePlayers,
  beginBattle,
  changeEdge,
  chooseEdge,
  currentMap,
  type DeployUnit,
  deployBanners,
  deployUnits,
  onEdge,
  placeUnit,
  playerChoosesEdge,
  turnUnit,
} from "../flow";
import { t } from "../i18n";
import type { BandHex } from "../map/view";
import { app, kitModal, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { fit, h, kit, mapSlot, row, statusbar } from "./common";

const { ARROW: A } = UI_THEME;

/** Side pane width in cells, and its content width (one cell of padding each side). */
const PANE = 38;
const W = PANE - 2;
/** Content rows of the 31-row split. */
const ROWS = 29;
const FACINGS: readonly Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
const ARROWS = A.facing;

/** Wrap kit controls and text into one text row. */
function line(key: string, cls: string, ...kids: (TuiNode | string)[]): TuiNode {
  return h().el("div", { key, class: `ia-row ${cls}`.trim() }, ...kids);
}

function hexText(hex: HexCoord): string {
  return `${String(hex.col).padStart(2, "0")},${String(hex.row).padStart(2, "0")}`;
}

function controlName(u: DeployUnit): string {
  return u.persona === null ? t("ctl.player") : PERSONAS[u.persona].name;
}

function report(run: () => void): void {
  try {
    run();
    app.error = null;
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
  }
  rerender();
}

export function deployScreen(): TuiNode {
  const H = h();
  const d = app.deploy!;
  const choosing = d.edges[0] === null;
  const side = choosing ? edgeRows() : unitRows();
  return H.el(
    "div",
    { class: "ia-root" },
    H.split(
      { cols: 100, rows: 31, border: "double", sizes: `1fr ${PANE}`, fixed: true },
      H.pane({ title: t("deploy.title", { map: app.loadout.map ?? "" }), pad: 0 }, mapSlot()),
      H.pane(t("deploy.side"), ...side),
    ),
    statusbar(
      choosing
        ? [
            [`${A.up}${A.right}${A.down}${A.left}`, "key.edge"],
            ["Enter", "key.select"],
            ["Esc", "key.discard", confirmDiscard],
            ["F10", "key.proceed", proceed],
          ]
        : [
            [`${A.up}${A.down}`, "key.unit"],
            [`${A.left}${A.right}`, "key.facing"],
            ["Tab", "key.next"],
            ["Esc", "key.discard", confirmDiscard],
            ["F10", "key.done", done],
          ],
      app.error ? `! ${app.error}` : t(choosing ? "deploy.mouseChoose" : "deploy.mouse"),
    ),
  );
}

/** Roll-off lines shared by both steps. */
function rollRows(): TuiNode[] {
  const d = app.deploy!;
  const rolls = d.roll.rolls;
  const [a, b] = rolls[rolls.length - 1]!;
  const out = [row(fit(t("deploy.rolls", { a, b }), W), { key: "rolls" })];
  if (rolls.length > 1) {
    const ties = rolls
      .slice(0, -1)
      .map(([x, y]) => `${x}:${y}`)
      .join(", ");
    out.push(row(fit(t("deploy.ties", { ties }), W), { key: "ties", cls: "ia-dim" }));
  }
  return out;
}

/** Fill the pane so `bottom` sits on its last rows. */
function pad(top: TuiNode[], bottom: TuiNode[]): TuiNode[] {
  const n = Math.max(0, ROWS - top.length - bottom.length);
  return [...top, ...Array.from({ length: n }, (_, i) => row(" ", { key: `pad${i}` })), ...bottom];
}

function footRows(): TuiNode[] {
  return [
    row(fit(t("deploy.free"), W), { cls: "ia-dim", key: "free" }),
    row(fit(t("deploy.tw"), W), { cls: "ia-dim", key: "tw" }),
  ];
}

// ------------------------------------------------------------ step 1: edge

function edgeButton(e: Edge): TuiNode {
  const d = app.deploy!;
  return h().btn(
    {
      key: `edge-${e}`,
      attrs: { "data-edge": e },
      primary: d.pickedEdge === e,
      onClick: () => {
        d.pickedEdge = e;
        rerender();
      },
      on: {
        mouseenter: () => {
          d.hoverEdge = e;
          rerender();
        },
        mouseleave: () => {
          if (d.hoverEdge === e) d.hoverEdge = null;
          rerender();
        },
        focus: () => {
          d.hoverEdge = e;
          rerender();
        },
      },
    },
    fit(t(`edge.${e}`), 7, "center"),
  );
}

function pickEdge(e: Edge): void {
  const d = app.deploy!;
  d.hoverEdge = null;
  d.pickedEdge = null;
  chooseEdge(e);
}

/** Proceed (F10): take the selected edge. */
function proceed(): void {
  const e = app.deploy!.pickedEdge;
  if (e) report(() => pickEdge(e));
}

function edgeRows(): TuiNode[] {
  const d = app.deploy!;
  const winner = d.roll.winner;
  // Button "[ North ]" is 11 cells; the compass is three of them wide.
  const mid = " ".repeat((W - 11) >> 1);
  const side = " ".repeat((W - 27) >> 1);
  const top: TuiNode[] = [
    ...rollRows(),
    row(fit(t("deploy.choose", { side: winner }), W), {
      key: "who",
      cls: winner === 1 ? "ia-team1" : "ia-team2",
    }),
    row(" ", { key: "b0" }),
    line("n", "", mid, edgeButton("north")),
    line("we", "", side, edgeButton("west"), "     ", edgeButton("east")),
    line("s", "", mid, edgeButton("south")),
    row(" ", { key: "b1" }),
    row(fit(t("deploy.opposite", { side: 3 - winner }), W), { key: "opp", cls: "ia-dim" }),
    row(fit(t("deploy.hoverEdge"), W), { key: "hov", cls: "ia-dim" }),
  ];
  return pad(top, [...footRows(), row(" ", { key: "b2" }), exitRow("proceed")]);
}

/**
 * Bottom buttons: Discard (Esc), then the F10 button: Proceed with the
 * selected edge while choosing, Done once the edges are set.
 */
function exitRow(next: "proceed" | "done"): TuiNode {
  const H = h();
  const len = (s: string) => kit().compensatedLength(s);
  const discard = `${t("deploy.discard")}  Esc`;
  const nextLabel = `${t(next === "done" ? "deploy.done" : "deploy.proceed")}  F10`;
  // a kit button adds four cells: "[ " and " ]"
  const width = len(discard) + 4 + 2 + len(nextLabel) + 4;
  const ready = next === "done" || app.deploy!.pickedEdge !== null;
  return line(
    "exit",
    "",
    " ".repeat(Math.max(0, (W - width) >> 1)),
    H.btn({ key: "discard", onClick: confirmDiscard }, discard),
    "  ",
    H.btn(
      { key: next, primary: ready, disabled: !ready, onClick: next === "done" ? done : proceed },
      nextLabel,
    ),
  );
}

// ------------------------------------------------------------ step 2: units

function edgesRow(): TuiNode {
  const d = app.deploy!;
  const half = (s: 0 | 1) =>
    h().el(
      "span",
      { class: s === 0 ? "ia-team1" : "ia-team2" },
      fit(`${t(s === 0 ? "setup.side1" : "setup.side2")}  ${t(`edge.${d.edges[s]}`)}`, W >> 1),
    );
  return line("edges", "", half(0), half(1));
}

function unitRow(u: DeployUnit, i: number): TuiNode {
  const H = h();
  const d = app.deploy!;
  const p = d.placements[u.id];
  const sel = i === d.cursor;
  const face = p ? p.facing.toUpperCase() : "--";
  const facing =
    u.persona === null && p
      ? H.btn(
          {
            key: "face",
            variant: "tight",
            // ← → turn the unit; Tab skips this button (one stop per unit list)
            attrs: { tabindex: "-1" },
            onClick: (e: MouseEvent) => {
              d.cursor = i;
              // A click on this button while its popup is open closes it.
              if (facingOpen === u.id) {
                kit().closePopup();
                return;
              }
              void openFacingMenu(u, e.currentTarget as HTMLElement);
            },
          },
          fit(face, 2),
        )
      : ` ${fit(face, 2)} `;
  const control = controlName(u);
  const long = kit().compensatedLength(control) > 16;
  return H.el(
    "div",
    {
      key: u.id,
      class: `ia-row ${u.side === 0 ? "ia-team1" : "ia-team2"}`,
      ...(long ? { tip: control } : {}),
    },
    sel ? A.cursor : " ",
    H.btn(
      {
        key: "unit",
        variant: "tight",
        // Roving focus: only the selected unit is a Tab stop; ↑ ↓ move it.
        attrs: { tabindex: sel ? "0" : "-1", "data-unit": u.id },
        onClick: () => {
          d.cursor = i;
          centerOnCursor();
        },
      },
      fit(u.id, 4),
    ),
    ` ${fit(p ? hexText(p.hex) : t("deploy.notPlaced"), 5)} `,
    facing,
    // one cell of slack: sub-pixel widths otherwise clip the last cell
    ` ${fit(control, 16)}`,
  );
}

function unitRows(): TuiNode[] {
  const d = app.deploy!;
  const H = h();
  const units = deployUnits(app.loadout);
  const winner = d.roll.winner;
  const head =
    "  " +
    fit(t("deploy.colUnit"), 6) +
    fit(t("deploy.colHex"), 6) +
    fit(t("deploy.colFace"), 5) +
    t("setup.control");
  const top: TuiNode[] = [
    ...rollRows(),
    row(fit(t("deploy.chose", { side: winner }), W), { key: "who" }),
    edgesRow(),
  ];
  if (playerChoosesEdge())
    top.push(
      line(
        "chg",
        "",
        H.btn(
          { key: "chg", onClick: () => report(changeEdge) },
          fit(t("deploy.changeEdge"), 14, "center"),
        ),
      ),
    );
  top.push(
    row(" ", { key: "b0" }),
    row(fit(t("deploy.units"), W), { key: "units", cls: "ia-bright" }),
    row(fit(head, W), { key: "head", cls: "ia-dim" }),
    ...units.map(unitRow),
  );
  if (units.some((u) => u.persona === null))
    top.push(
      row(" ", { key: "b1" }),
      line(
        "auto",
        "",
        H.btn(
          { key: "auto", onClick: () => report(autoPlacePlayers) },
          fit(t("deploy.autoPlace"), 14, "center"),
        ),
      ),
    );
  return pad(top, [...footRows(), row(" ", { key: "b2" }), exitRow("done")]);
}

// ------------------------------------------------------------ actions

function done(): void {
  report(beginBattle);
}

/** Discard the battle and go back to the title (the loadout stays saved). */
function confirmDiscard(): void {
  kitModal.open = true;
  void kit()
    .dialog({
      title: t("deploy.discardTitle"),
      text: t("deploy.discardText"),
      buttons: [t("yes"), t("no")],
      defaultIndex: 1,
      tone: "warn",
    })
    .then((r) => {
      kitModal.open = false;
      if (r === t("yes")) {
        app.screen = "title";
        app.deploy = null;
        app.error = null;
        app.mapView?.reset(); // drop the deployment pan and zoom
      }
      rerender();
    });
}

function centerOnCursor(): void {
  const d = app.deploy!;
  const u = deployUnits(app.loadout)[d.cursor];
  const p = u ? d.placements[u.id] : undefined;
  if (p) app.mapView?.centerOn(p.hex);
}

/** Unit whose facing popup is open: a second click on its button closes it. */
let facingOpen: string | null = null;

/** Facing popup at `anchor`; arrows follow the map's rotation. */
function openFacingMenu(u: DeployUnit, anchor: HTMLElement): Promise<void> {
  const d = app.deploy!;
  const p = d.placements[u.id];
  if (!p) return Promise.resolve();
  const angle = app.mapView?.angle ?? 0;
  kitModal.open = true;
  facingOpen = u.id;
  return kit()
    .popupMenu(
      anchor,
      FACINGS.map((f, i) => {
        const dir = (i * 60 - angle + 360) % 360;
        return { label: `${ARROWS[Math.round(dir / 60) % 6]} ${f.toUpperCase()}` };
      }),
      { active: FACINGS.indexOf(p.facing) },
    )
    .then((r) => {
      kitModal.open = false;
      if (facingOpen === u.id) facingOpen = null;
      if (r && "index" in r) {
        const f = FACINGS[r.index];
        if (f) p.facing = f;
      }
      rerender();
    });
}

function pointAnchor(ev: MouseEvent): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;left:${ev.clientX}px;top:${ev.clientY}px;width:1px;height:1px`;
  document.body.appendChild(el);
  return el;
}

/** A click on the map: choose an edge, select a unit, turn it, or place it. */
function pickHex(hex: HexCoord, ev: MouseEvent, facing: Facing | null): void {
  const d = app.deploy!;
  const map = currentMap();
  if (d.edges[0] === null) {
    if (!playerChoosesEdge()) return;
    const edge = EDGES.find((e) => onEdge(map, e, hex));
    if (!edge) throw new Error(t("err.notEdge"));
    d.pickedEdge = edge;
    return;
  }
  const units = deployUnits(app.loadout);
  const at = units.findIndex((u) => {
    const p = d.placements[u.id];
    return p !== undefined && p.hex.col === hex.col && p.hex.row === hex.row;
  });
  if (at >= 0) {
    const u = units[at]!;
    if (at === d.cursor && u.persona === null) {
      // a facing triangle turns it; its banner opens the facing menu
      if (facing !== null) {
        d.placements[u.id]!.facing = facing;
        return;
      }
      const anchor = pointAnchor(ev);
      void openFacingMenu(u, anchor).then(() => anchor.remove());
    } else {
      d.cursor = at;
      d.focusUnit = true;
    }
    return;
  }
  const u = units[d.cursor];
  if (u) placeUnit(u.id, hex, facing);
}

/** Map overlays: the hovered edge while choosing, else the selected unit's free edge hexes. */
export function deployOverlays(): void {
  const v = app.mapView;
  const d = app.deploy;
  if (!v || !d) return;
  const map = currentMap();
  const zone = new Map<string, BandHex>();
  let chosen: { hex: string; facing: Facing } | null = null;
  if (d.edges[0] === null) {
    const shown = d.hoverEdge ?? d.pickedEdge;
    if (shown)
      for (const hx of edgeHexes(map, shown))
        zone.set(`${hx.col},${hx.row}`, { team: d.roll.winner, facings: FACINGS });
  } else {
    const u = deployUnits(app.loadout)[d.cursor];
    const edge = u ? d.edges[u.side] : null;
    if (u && edge && u.persona === null) {
      // others' hexes are taken; the unit's own hex stays banded to re-face it
      const taken = new Set(
        Object.entries(d.placements)
          .filter(([id]) => id !== u.id)
          .map(([, p]) => `${p.hex.col},${p.hex.row}`),
      );
      for (const hx of edgeHexes(map, edge)) {
        const k = `${hx.col},${hx.row}`;
        // Deployment allows any facing; later phases may band only some sides.
        if (!taken.has(k)) zone.set(k, { team: u.side + 1, facings: FACINGS });
      }
      const p = d.placements[u.id];
      if (p) chosen = { hex: `${p.hex.col},${p.hex.row}`, facing: p.facing };
    }
  }
  v.overlays = { bands: zone, chosen };
  v.banners = deployBanners();
  v.onPick = (hex, ev, facing) => report(() => pickHex(hex, ev, facing));
}

/** After a render: move the focus to the selected unit's button when asked (one cursor). */
export function deployAfterRender(): void {
  const d = app.deploy;
  if (!d?.focusUnit) return;
  d.focusUnit = false;
  const u = deployUnits(app.loadout)[d.cursor];
  if (u) document.querySelector<HTMLElement>(`#app [data-unit="${CSS.escape(u.id)}"]`)?.focus();
}

const ARROW_EDGE: Partial<Record<string, Edge>> = {
  ArrowUp: "north",
  ArrowRight: "east",
  ArrowDown: "south",
  ArrowLeft: "west",
};

export function deployKey(e: KeyboardEvent): boolean {
  const d = app.deploy!;
  if (e.key === "Escape") {
    confirmDiscard();
    return true;
  }
  if (d.edges[0] === null) {
    // Arrows select an edge outright (↑ north, → east, ↓ south, ← west);
    // Proceed (F10) takes it.
    if (e.key === "F10") {
      proceed();
      return true;
    }
    const edge = ARROW_EDGE[e.key];
    if (!edge) return false;
    d.pickedEdge = edge;
    document.querySelector<HTMLElement>(`#app [data-edge="${edge}"]`)?.focus();
    return true;
  }
  const units = deployUnits(app.loadout);
  if (e.key === "F10") beginBattle();
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = units.length;
    d.cursor = (d.cursor + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    d.focusUnit = true;
    centerOnCursor();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const u = units[d.cursor];
    if (u) turnUnit(u.id, e.key === "ArrowRight" ? 1 : -1);
  } else return false;
  return true;
}
