/**
 * Screen 2: deployment (TW p. 256 roll-off, home edges, placement), one
 * screen: a Player roll-off winner picks the home edge from a dropdown (no
 * edge yet holds Done back), every unit is auto-placed on it, and the map
 * takes clicks (place or select a unit, turn the selected one). Persona
 * units are placed by the engine and cannot be moved or turned.
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
  placeUnit,
  playerChoosesEdge,
  turnUnit,
} from "../flow";
import { t } from "../i18n";
import type { BandHex } from "../map/view";
import { app, kitModal, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { controls, fit, h, kit, mapSlot, nearest, row, statusbar } from "./common";
import { menuKey, menuWindow, openMenu, prefItems } from "./menu";

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
  const unset = d.edges[0] === null;
  return H.el(
    "div",
    { class: "ia-root" },
    H.split(
      { cols: 100, rows: 31, border: "double", sizes: `1fr ${PANE}`, fixed: true },
      H.pane({ title: t("deploy.title", { map: app.loadout.map ?? "" }), pad: 0 }, mapSlot()),
      H.pane(t("deploy.side"), ...paneRows()),
    ),
    statusbar(
      [
        [`${A.up}${A.down}`, "key.unit"],
        [`${A.left}${A.right}`, "key.facing"],
        ["Bksp", "key.unplace"],
        ["Esc", "key.menu", openDeployMenu],
        ["F10", "key.done", done],
      ],
      app.error ? `! ${app.error}` : t(unset ? "deploy.pickEdge" : "deploy.mouse"),
    ),
    app.modal ? menuWindow(app.modal) : null,
  );
}

/** Roll-off lines. */
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

/** Bottom buttons: Discard, then Done (F10), held back until the home edges are set. */
function exitRow(): TuiNode {
  const H = h();
  const len = (s: string) => kit().compensatedLength(s);
  const discard = t("deploy.discard");
  const nextLabel = `${t("deploy.done")}  F10`;
  // a kit button adds four cells: "[ " and " ]"
  const width = len(discard) + 4 + 2 + len(nextLabel) + 4;
  const ready = app.deploy!.edges[0] !== null;
  return line(
    "exit",
    "",
    " ".repeat(Math.max(0, (W - width) >> 1)),
    H.btn({ key: "discard", onClick: confirmDiscard }, discard),
    "  ",
    H.btn(
      {
        key: "done",
        primary: ready,
        disabled: !ready,
        // F10 or a click only: Enter / Space on the focused button does nothing
        attrs: { "data-commit": "" },
        onClick: done,
      },
      nextLabel,
    ),
  );
}

// ------------------------------------------------------------ edges and units

function edgesRow(): TuiNode {
  const d = app.deploy!;
  const half = (s: 0 | 1) => {
    const e = d.edges[s];
    return h().el(
      "span",
      { class: s === 0 ? "ia-team1" : "ia-team2" },
      fit(`${t(s === 0 ? "setup.side1" : "setup.side2")}  ${e ? t(`edge.${e}`) : "--"}`, W >> 1),
    );
  };
  return line("edges", "", half(0), half(1));
}

/** The winner's home edge: a dropdown for a Player winner ("Not selected" first). */
function edgeSelect(): TuiNode {
  const d = app.deploy!;
  const winner = d.roll.winner;
  const values = [null, ...EDGES] as const;
  const at = values.indexOf(d.edges[winner - 1] ?? null);
  return line(
    "edge",
    "ia-deploy-edge",
    fit(t("deploy.homeEdge"), 12),
    h().select({
      key: "edgesel",
      cols: 16,
      value: String(at),
      options: values.map((e, i) => ({
        value: String(i),
        label: e === null ? t("deploy.noEdge") : t(`edge.${e}`),
      })),
      onChange: (ev: Event) => {
        const e = values[Number((ev.target as HTMLSelectElement).value)];
        report(() => setEdge(e ?? null));
      },
    }),
  );
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

function paneRows(): TuiNode[] {
  const d = app.deploy!;
  const H = h();
  const units = deployUnits(app.loadout);
  const winner = d.roll.winner;
  const chooser = playerChoosesEdge();
  const head =
    "  " +
    fit(t("deploy.colUnit"), 6) +
    fit(t("deploy.colHex"), 6) +
    fit(t("deploy.colFace"), 5) +
    t("setup.control");
  const top: TuiNode[] = [
    ...rollRows(),
    row(fit(t(chooser ? "deploy.won" : "deploy.chose", { side: winner }), W), {
      key: "who",
      cls: winner === 1 ? "ia-team1" : "ia-team2",
    }),
    ...(chooser ? [edgeSelect()] : []),
    edgesRow(),
  ];
  // the unit list only once there is a home edge to stand on
  if (d.edges[0] !== null)
    top.push(
      row(" ", { key: "b0" }),
      row(fit(t("deploy.units"), W), { key: "units", cls: "ia-bright" }),
      row(fit(head, W), { key: "head", cls: "ia-dim" }),
      ...units.map(unitRow),
    );
  if (d.edges[0] !== null && units.some((u) => u.persona === null))
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
  return pad(top, [...footRows(), exitRow(), row(" ", { key: "b2" })]);
}

// ------------------------------------------------------------ actions

/** Done (F10): only once the home edges are set. */
function done(): void {
  if (app.deploy!.edges[0] === null) {
    app.error = t("deploy.pickEdge");
    rerender();
    return;
  }
  report(beginBattle);
}

/** The winner's home edge (null: none yet); every unit is auto-placed again. */
function setEdge(e: Edge | null): void {
  changeEdge();
  if (e) chooseEdge(e);
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

/**
 * A click on the map (or A on the reticle): choose an edge, select a unit,
 * turn it, or place it. On a banded hex the map view has already picked the
 * facing (`pickFacing`): on the selected unit's own hex, the next one clockwise.
 */
function pickHex(hex: HexCoord, facing: Facing | null): void {
  const d = app.deploy!;
  if (d.edges[0] === null) return; // no home edge yet: nothing to place
  const units = deployUnits(app.loadout);
  const at = units.findIndex((u) => {
    const p = d.placements[u.id];
    return p !== undefined && p.hex.col === hex.col && p.hex.row === hex.row;
  });
  if (at >= 0) {
    const u = units[at]!;
    if (at === d.cursor && u.persona === null) {
      if (facing !== null) d.placements[u.id]!.facing = facing;
    } else {
      d.cursor = at;
      d.focusUnit = true;
    }
    return;
  }
  const u = units[d.cursor];
  if (u) placeUnit(u.id, hex, facing);
}

/** Map overlays: the selected unit's free home-edge hexes. */
export function deployOverlays(): void {
  const v = app.mapView;
  const d = app.deploy;
  if (!v || !d) return;
  const map = currentMap();
  const zone = new Map<string, BandHex>();
  let chosen: { hex: string; facing: Facing } | null = null;
  {
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
  v.onPick = (hex, facing) => report(() => pickHex(hex, facing));
}

/** After a render: move the focus to the selected unit's button when asked, or when nothing has it. */
export function deployAfterRender(): void {
  const d = app.deploy;
  if (!d) return;
  // nothing focused yet (the screen just opened): start on the edge dropdown
  // while no edge is set, else on the selected unit
  const idle = !app.modal && (document.activeElement === document.body || !document.activeElement);
  if (idle && d.edges[0] === null && playerChoosesEdge()) {
    document.querySelector<HTMLElement>("#app .ia-deploy-edge .tui-select")?.focus();
    return;
  }
  if (!d.focusUnit && !idle) return;
  d.focusUnit = false;
  const u = deployUnits(app.loadout)[d.cursor];
  if (u) document.querySelector<HTMLElement>(`#app [data-unit="${CSS.escape(u.id)}"]`)?.focus();
}

/** Esc menu: Done, Discard, then Options. */
function openDeployMenu(): void {
  openMenu(t("deployMenu.title"), [
    { label: () => t("deploy.done"), run: done },
    { label: () => t("deploy.discard"), run: confirmDiscard },
    ...prefItems(),
  ]);
}

export function deployKey(e: KeyboardEvent): boolean {
  const d = app.deploy!;
  const m = app.modal;
  if (m?.kind === "menu" || m?.kind === "options") return menuKey(e, m);
  if (e.key === "Escape") {
    openDeployMenu();
    return true;
  }
  const units = deployUnits(app.loadout);
  if (e.key === "F10") done();
  else if (e.key === "Backspace") {
    // pick the selected Player unit back up
    const u = units[d.cursor];
    if (u && u.persona === null) delete d.placements[u.id];
  } else if (e.key.startsWith("Arrow")) unitArrow(e.key, units);
  else return false;
  return true;
}

/**
 * Arrows on the edge dropdown, ahead of the kit's own keys (capture phase):
 * they move to the nearest control as everywhere else; Enter opens it.
 */
export function deployArrow(e: KeyboardEvent): boolean {
  if (app.modal || e.shiftKey || !e.key.startsWith("Arrow")) return false;
  if (!(e.target as Element | null)?.closest?.(".ia-deploy-edge")) return false;
  unitArrow(e.key, deployUnits(app.loadout));
  return true;
}

/**
 * Deployment arrows. On the unit list (or with nothing focused) ↑ ↓ select a
 * unit and ← → turn it; ↑ past the first unit or ↓ past the last leaves the
 * list for the nearest button that way. On a button, every arrow moves to the
 * nearest control, the selected unit's list entry included.
 */
function unitArrow(key: string, units: readonly DeployUnit[]): void {
  const d = app.deploy!;
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // the list: a unit or its facing button, or nothing focused
  const onList =
    !el || el === document.body || !!el.closest(".ia-row")?.querySelector("[data-unit]");
  const vertical = key === "ArrowDown" || key === "ArrowUp";
  const step = key === "ArrowDown" ? 1 : -1;
  if (onList && vertical && d.cursor + step >= 0 && d.cursor + step < units.length) {
    d.cursor += step;
    d.focusUnit = true;
    centerOnCursor();
    return;
  }
  if (onList && !vertical) {
    const u = units[d.cursor];
    if (u) turnUnit(u.id, key === "ArrowRight" ? 1 : -1);
    return;
  }
  const root = document.querySelector<HTMLElement>("#app .ia-root");
  const from =
    el && el !== document.body
      ? el
      : document.querySelector<HTMLElement>('#app [data-unit][tabindex="0"]');
  if (root && from) nearest(from, controls(root), key)?.focus();
}
