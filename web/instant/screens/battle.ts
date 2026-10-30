/** Screen 3: the battle HUD (full map, frame, drawers, orders) and its windows. */
import {
  type Facing,
  type FireTarget,
  heatDissipation,
  hitProbability,
  isHull,
  isUnitOnBoard,
  mechDefFor,
  type PhysicalAttackDecl,
  type RevealedLanding,
  type Twist,
  weaponDefFor,
} from "btlib10x";
import type { MoveChoice } from "../battle/controller";
import { tallies } from "../battle/victory";
import { battleBanners, holdAi, pumpAi, stopAi } from "../flow";
import { locName, t } from "../i18n";
import { AI_PACES, type AttackRow, app, kitModal, rerender, setAiPace } from "../state";
import { UI_THEME } from "../theme";
import type { TuiChild, TuiNode } from "../tui";
import {
  BODY,
  battleFrame,
  doneButton,
  focusMover,
  openSheetFor,
  setLogs,
  sheetSideOf,
  toggleLogs,
  toggleSheet,
} from "./battle.hud";
import { SHEET_W } from "./battle.sheet";
import { at, blank, cells, fit, h, kit, mapSlot, modal, row, span, statusbar } from "./common";
import { pileTipFor } from "./piles";
import { policyWindow } from "./setup";

const { MARK: M, ARROW: A } = UI_THEME;

const ATTACK_W = 45;
const TWISTS: Twist[] = ["front", "leftSide", "rightSide"];
/** Modes with no hex or facing to pick: they live under the Hold dropdown. */
const STATIONARY = new Set<MoveChoice>([
  "standStill",
  "standupStill",
  "proneStill",
  "pronestill",
  "shutdown",
  "startup",
  "eject",
  "abandon",
]);
type StatusKey = readonly [string, string, (() => void)?];
const FACING_ORDER = ["n", "ne", "se", "s", "sw", "nw"] as const;

function setError(e: unknown): void {
  app.error = e instanceof Error ? e.message : String(e);
}

function act(fn: () => void): void {
  try {
    fn();
    app.error = null;
  } catch (e) {
    setError(e);
  }
}

// ------------------------------------------------------------ movement orders

function landingMp(l: RevealedLanding): number {
  return l.path.reduce((n, s) => n + s.baseMp, 0);
}

/** A stationary mode, or a mode with its hex and facing: DONE can commit it. */
function moveReady(): boolean {
  const d = app.battle?.move;
  if (!d?.choice) return false;
  return STATIONARY.has(d.choice) || d.landing !== null;
}

function pickMove(c: MoveChoice): void {
  const b = app.battle!;
  app.orderCursor = Math.max(0, b.moveChoices().indexOf(c));
  act(() => b.chooseMove(c));
  rerender();
}

function openHoldMenu(hold: MoveChoice[], e: MouseEvent): void {
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  if (!el) return;
  const current = app.battle?.move?.choice ?? null;
  kitModal.open = true;
  void kit()
    .popupMenu(
      el,
      hold.map((c) => ({
        label: `${c === current ? M.on : " "} ${fit(t(`choice.${c}`), 16)}`,
      })),
      { active: Math.max(0, hold.indexOf(current as MoveChoice)) },
    )
    .then((r) => {
      kitModal.open = false;
      const c = r && "index" in r ? hold[r.index] : undefined;
      if (c) pickMove(c);
      else rerender();
    });
}

/** Mode bar: the Hold dropdown, then the modes that pick a hex. */
function moveMenu(): { rows: TuiNode[]; width: number } {
  const b = app.battle!;
  const choices = b.moveChoices();
  const draft = b.move!;
  const hold = choices.filter((c) => STATIONARY.has(c));
  const modes = choices.filter((c) => !STATIONARY.has(c));
  const cursor = choices[app.orderCursor];
  const held = draft.choice && STATIONARY.has(draft.choice) ? draft.choice : null;
  const kids: TuiChild[] = [" "];
  let width = 2;
  const add = (text: string, node: TuiChild = text) => {
    kids.push(node);
    width += cells(text);
  };
  if (hold.length > 0) {
    const label = held ? `${M.on}${t(`choice.${held}`)}` : t("orders.hold");
    const text = `[${label} ${A.drop}]`;
    add(
      text,
      span(text, {
        key: "hold",
        cls: cursor && STATIONARY.has(cursor) ? "sel" : held ? "ia-bright" : "",
        onClick: (e) => openHoldMenu(hold, e),
      }),
    );
  }
  for (const c of modes) {
    const on = draft.choice === c;
    const mp = b.budgetFor(c);
    if (kids.length > 1) add("  ");
    const text = `[${on ? M.on : ""}${t(`choice.${c}`)}${mp > 0 ? `:${mp}MP` : ""}]`;
    add(
      text,
      span(text, {
        key: c,
        cls: c === cursor ? "sel" : on ? "ia-bright" : "",
        onClick: () => pickMove(c),
      }),
    );
  }
  kids.push(" ");
  return { rows: [h().el("div", { class: "ia-row", key: "modes" }, ...kids)], width };
}

/** The movement hint (and a melee warning) for the right of the status line. */
function moveHint(): TuiChild[] {
  const b = app.battle!;
  const draft = b.move;
  if (!draft || b.actorPersona !== null) return [];
  const l = draft.landing;
  const info = l
    ? t("orders.landing", {
        col: l.hex.col,
        row: l.hex.row,
        facing: l.facing.toUpperCase(),
        mp: landingMp(l),
      })
    : draft.choice && draft.landings.length > 0
      ? t("orders.clickHex")
      : draft.choice
        ? t("orders.noMoveNeeded")
        : t("orders.chooseMode");
  const out: TuiChild[] = [span(info, { cls: "ia-accent", key: "info" })];
  if (l?.melee)
    out.push(
      span(` ${t("orders.melee", { kind: l.melee.kind })}`, { cls: "ia-err", key: "melee" }),
    );
  return out;
}

// ------------------------------------------------------------ attack orders

export function attackRows(): AttackRow[] {
  const b = app.battle!;
  const target = currentTarget();
  const rows: AttackRow[] = [];
  if (target) {
    for (const w of target.weapons)
      rows.push({ kind: "weapon", weaponIndex: w.weaponIndex, enabled: true });
    for (const w of target.blocked)
      rows.push({ kind: "weapon", weaponIndex: w.weaponIndex, enabled: false });
  }
  for (const o of b.physicalOptions()) rows.push({ kind: "physical", decl: o.decl });
  for (const s of b.pickupOptions()) rows.push({ kind: "pickup", source: s });
  if (b.actor?.club) rows.push({ kind: "drop" });
  return rows;
}

function currentTarget(): FireTarget | null {
  const b = app.battle!;
  const id = b.attack?.targetId;
  return b.fireSuggestion()?.targets.find((x) => x.targetId === id) ?? null;
}

function samePhys(a: PhysicalAttackDecl, d: PhysicalAttackDecl): boolean {
  return a.type === d.type && a.targetId === d.targetId && a.limb === d.limb;
}

function limbWord(limb: string | undefined): string {
  return limb ? t(`limb.${limb}`) : "";
}

function attackOrders(width: number): TuiNode[] {
  const b = app.battle!;
  const draft = b.attack!;
  const unit = b.actor!;
  const def = mechDefFor(unit);
  const sugg = b.fireSuggestion();
  const target = currentTarget();
  const twist = TWISTS.map(
    (x) => `${draft.twist === x ? `(${M.on})` : "( )"} ${t(`twist.${x}`)}`,
  ).join(" ");
  const tu = target ? b.state.units[target.targetId] : null;
  const targetLine = tu
    ? `${A.prev} ${tu.id} ${tu.model} ${M.sep} ${t("orders.hexes", { n: target!.distance })} ${A.next}`
    : sugg && sugg.targets.length === 0
      ? t("orders.noTargets")
      : t("orders.pickTarget");
  const out: TuiNode[] = [
    row(fit(`${t("orders.twist")} ${twist}`, width), {
      key: "twist",
      onClick: () => act(() => b.setTwist(TWISTS[(TWISTS.indexOf(draft.twist) + 1) % 3]!)),
    }),
    row(fit(`${t("orders.target")} ${targetLine}`, width), {
      key: "target",
      cls: "ia-bright",
      onClick: () => cycleTarget(1),
    }),
    row(
      ` ${fit("", 3)} ${fit(t("mech.weapon"), 13)}${fit(t("mech.loc"), 4)}${fit("TN", 3, "right")}${fit(t("orders.hit"), 5, "right")}${fit(t("mech.dmg"), 5, "right")}${fit(t("mech.heat"), 4, "right")}`,
      { cls: "ia-dim", key: "th" },
    ),
  ];
  const rows = attackRows();
  let heat = 0;
  const list: TuiNode[] = [];
  rows.forEach((r, i) => {
    const sel = i === app.orderCursor;
    if (r.kind === "weapon") {
      const mount = def.weapons[r.weaponIndex]!;
      const checked = draft.weapons.includes(r.weaponIndex);
      const wd = weaponDefFor(mount);
      if (checked) heat += wd.heat ?? 0;
      if (r.enabled) {
        const fw = target!.weapons.find((w) => w.weaponIndex === r.weaponIndex)!;
        const dmg = fw.cluster
          ? `${fw.cluster.shots}${M.times}${fw.cluster.perMissile}`
          : String(Math.round(fw.expectedDamage * 10) / 10);
        list.push(
          row(
            ` ${checked ? "[x]" : "[ ]"} ${fit(mount.weapon, 13)}${fit(locName(mount.location), 4)}${fit(fw.tn, 3, "right")}${fit(`${Math.round(hitProbability(fw.tn) * 100)}%`, 5, "right")}${fit(dmg, 5, "right")}${fit(fw.heat, 4, "right")}`,
            {
              sel,
              key: `w${r.weaponIndex}`,
              cls: checked ? "hot" : "",
              onClick: () => toggleRow(i),
            },
          ),
        );
      } else {
        const why = target!.blocked.find((w) => w.weaponIndex === r.weaponIndex)?.reason ?? "";
        list.push(
          row(
            fit(
              `  -  ${fit(mount.weapon, 13)}${fit(locName(mount.location), 4)} ${t(`block.${why}`)}`,
              width,
            ),
            { sel, cls: "dim", key: `b${r.weaponIndex}` },
          ),
        );
      }
    } else if (r.kind === "physical") {
      const opt = b.physicalOptions().find((o) => samePhys(o.decl, r.decl));
      const checked = draft.physical.some((d) => samePhys(d, r.decl));
      list.push(
        row(
          fit(
            ` ${checked ? "[x]" : "[ ]"} ${t(`phys.${r.decl.type}`)} ${r.decl.targetId} ${limbWord(r.decl.limb)}  TN ${opt?.toHit ?? "-"} ${opt ? Math.round(hitProbability(opt.toHit) * 100) : 0}%  ${opt?.damage ?? 0} ${t("mech.dmg")}`,
            width,
          ),
          {
            sel,
            key: `p${r.decl.type}${r.decl.targetId}${r.decl.limb ?? ""}`,
            cls: checked ? "hot" : "",
            onClick: () => toggleRow(i),
          },
        ),
      );
    } else if (r.kind === "pickup") {
      const checked = draft.pickup?.source === r.source;
      list.push(
        row(
          fit(
            ` ${checked ? "[x]" : "[ ]"} ${t("orders.pickup", { source: t(`club.${r.source}`) })}`,
            width,
          ),
          { sel, key: `pk${r.source}`, onClick: () => toggleRow(i) },
        ),
      );
    } else {
      list.push(
        row(fit(` ${draft.dropClub ? "[x]" : "[ ]"} ${t("orders.drop")}`, width), {
          sel,
          key: "drop",
          onClick: () => toggleRow(i),
        }),
      );
    }
  });
  const VISIBLE = 13;
  const start = Math.max(0, Math.min(app.orderCursor - 6, rows.length - VISIBLE));
  out.push(...list.slice(start, start + VISIBLE));
  if (rows.length > VISIBLE)
    out.push(
      row(fit(`  ${start + 1}-${Math.min(rows.length, start + VISIBLE)} / ${rows.length}`, width), {
        cls: "ia-dim",
        key: "more",
      }),
    );
  const now = unit.heat + unit.heatPending;
  const sinks = heatDissipation(def, unit.damage, unit.critSlotsDestroyed);
  out.push(
    row(
      fit(
        t("orders.heatAfter", { now, fire: heat, sinks, after: Math.max(0, now + heat - sinks) }),
        width,
      ),
      { cls: "ia-dim", key: "heat" },
    ),
  );
  return out;
}

function toggleRow(i: number): void {
  const b = app.battle!;
  const r = attackRows()[i];
  app.orderCursor = i;
  if (!r) return;
  act(() => {
    if (r.kind === "weapon") {
      if (r.enabled) b.toggleWeapon(r.weaponIndex);
    } else if (r.kind === "physical") b.togglePhysical(r.decl);
    else if (r.kind === "pickup") b.togglePickup(r.source);
    else b.toggleDrop();
  });
  rerender();
}

function cycleTarget(dir: number): void {
  const b = app.battle!;
  const list = b.fireSuggestion()?.targets ?? [];
  if (list.length === 0) return;
  const i = list.findIndex((x) => x.targetId === b.attack?.targetId);
  const next = list[(i + dir + list.length) % list.length]!;
  pickTarget(next.targetId);
}

/** Aim at a unit and show its record sheet in the right drawer. */
function pickTarget(id: string): void {
  const b = app.battle!;
  act(() => b.setTarget(id));
  app.orderCursor = 0;
  showTargetSheet();
  rerender();
}

/** The attack target's sheet in the right drawer, once per new target. */
function showTargetSheet(): void {
  const b = app.battle;
  const id = b?.attack?.targetId ?? null;
  const ui = app.battleUi;
  const key = `${b?.actorId}>${id}`;
  if (id === null || key === ui.sheetTarget) return;
  ui.sheetTarget = key;
  ui.framePending = true;
  const side = sheetSideOf(id);
  const d = ui.sheets[side];
  d.unitId = id;
  d.openedAt = ++ui.seq;
  if (ui.logSheets) ui.logSheets[side] = true;
  else d.open = true;
}

/**
 * The biggest clear part of the map, in canvas px: inside the open drawers'
 * tabs (or the closed edge tabs), and below or beside the orders box.
 */
function clearArea(canvas: HTMLCanvasElement): { x0: number; y0: number; x1: number; y1: number } {
  const ui = app.battleUi;
  const cw = canvas.clientWidth / BODY.cols;
  const ch = canvas.clientHeight / BODY.rows;
  const left = ui.sheets[0].open ? SHEET_W + 3 : 3;
  const right = ui.sheets[1].open ? 99 - SHEET_W - 2 : 97;
  const bottom = BODY.row + BODY.rows;
  const m = ui.menuBox;
  const m0 = m ? BODY.col + Math.floor((BODY.cols - m.cols) / 2) : 0;
  const m1 = m ? m0 + m.cols : 0;
  const mb = m ? BODY.row + m.rows : BODY.row;
  const areas = [
    [left, mb, right, bottom],
    [left, BODY.row, Math.min(right, m0), bottom],
    [Math.max(left, m1), BODY.row, right, bottom],
  ].map(([x0, y0, x1, y1]) => ({
    x0: (x0! - BODY.col) * cw,
    y0: (y0! - BODY.row) * ch,
    x1: (x1! - BODY.col) * cw,
    y1: (y1! - BODY.row) * ch,
  }));
  const area = (r: (typeof areas)[number]) =>
    Math.max(0, r.x1 - r.x0) *
    Math.max(0, r.y1 - r.y0) *
    (r.x1 - r.x0 > 8 * cw && r.y1 - r.y0 > 4 * ch ? 1 : 0.01);
  return areas.reduce((a, r) => (area(r) > area(a) ? r : a));
}

// ------------------------------------------------------------ screen

function title(): string {
  const b = app.battle!;
  const s = tallies(b.state, b.totals);
  if (b.mode.kind === "damageRace") {
    return t("battle.race", {
      a: s[0]!.dealt,
      b: s[1]!.dealt,
    });
  }
  return t("battle.destroyAll", { a: s[0]!.units - s[0]!.lost, b: s[1]!.units - s[1]!.lost });
}

/**
 * Orders over the map: centred at the top in a rounded kit box, opaque text
 * on 75% black inset like the drawers.
 */
function topMenu(rows: TuiNode[], width: number, top: number, title: string | null): TuiNode {
  return at(
    BODY.col,
    top,
    { class: "ia-topmenu", key: "topmenu", style: { width: `calc(${BODY.cols} * var(--cw))` } },
    h().box(
      {
        cols: Math.min(BODY.cols, width + 2),
        border: "rounded",
        pad: 0,
        class: "ia-menu",
        key: "menu",
        ...(title ? { title } : {}),
      },
      ...rows,
    ),
  );
}

interface Orders {
  menu: TuiNode[];
  /** Widest menu row, in cells. */
  width: number;
  done: boolean;
  /** Group name on the box border, or null (the AI acting). */
  title: string | null;
}

/** One plain text row of the orders menu, and its width. */
function textRow(text: string, cls: string, key: string): [TuiNode, number] {
  return [row(` ${text} `, { cls, key }), cells(` ${text} `)];
}

function orders(): Orders {
  const b = app.battle!;
  const u = b.actor;
  const extra: [TuiNode, number][] = app.error ? [textRow(`! ${app.error}`, "ia-err", "err")] : [];
  const out = (
    menu: TuiNode[],
    width: number,
    done: boolean,
    title: string | null = null,
  ): Orders => ({
    menu: [...menu, ...extra.map((x) => x[0])],
    width: Math.max(width, ...extra.map((x) => x[1])),
    done,
    title,
  });
  if (!u) return out([], 0, false);
  if (b.actorPersona !== null) {
    const ai = [textRow(t("orders.aiActing", { id: u.id }), "ia-accent", "ai")];
    if (app.aiPace === "step") ai.push(textRow(t("orders.aiStep"), "ia-dim", "ais"));
    return out(
      ai.map((x) => x[0]),
      Math.max(...ai.map((x) => x[1])),
      false,
    );
  }
  if (b.phase === "movement") {
    const m = moveMenu();
    const title = t("orders.moveTitle");
    return out(m.rows, Math.max(m.width, cells(title) + 4), moveReady(), title);
  }
  showTargetSheet();
  return out(attackOrders(ATTACK_W), ATTACK_W, true, t("orders.attackTitle"));
}

const MOVE_KEYS: StatusKey[] = [["Mouse", "key.clickHex"]];
const ATTACK_KEYS: StatusKey[] = [
  ["Tab", "key.target"],
  ["T", "key.twist"],
  ["Spc", "key.weapon"],
  ["A/N", "key.allNone"],
];

export function battleScreen(): TuiNode {
  const H = h();
  const b = app.battle!;
  const phase = b.phase === "attack" ? "attack" : "movement";
  focusMover();
  const o = orders();
  app.battleUi.menuBox =
    o.menu.length > 0 ? { cols: Math.min(BODY.cols, o.width + 2), rows: o.menu.length + 2 } : null;
  const map = at(
    BODY.col,
    BODY.row,
    {
      class: "ia-mapwrap",
      key: "map",
      style: { width: `calc(${BODY.cols} * var(--cw))`, height: `calc(${BODY.rows} * var(--ch))` },
    },
    mapSlot(),
  );
  return H.el(
    "div",
    { class: "ia-root ia-battle" },
    ...battleFrame(
      title(),
      [map, o.done ? doneButton(() => commit()) : null],
      o.menu.length > 0 ? [topMenu(o.menu, o.width, BODY.row, o.title)] : [],
    ),
    statusbar(
      [
        ...(phase === "movement" ? MOVE_KEYS : ATTACK_KEYS),
        ...(o.done ? [["F10", "key.done", () => commit()] as const] : []),
        ["[", "key.sheetLeft", () => toggleSheet(0)],
        ["]", "key.sheetRight", () => toggleSheet(1)],
        ["L", "key.logs", () => toggleLogs()],
        [
          "Esc",
          "key.menu",
          () => {
            openMenu();
            rerender();
          },
        ],
      ],
      phase === "movement" ? moveHint() : [],
    ),
    app.modal ? battleModal() : null,
  );
}

function commit(): void {
  const b = app.battle!;
  act(() => (b.phase === "movement" ? b.commitMove() : b.commitAttack()));
  app.orderCursor = 0;
  pumpAi();
}

// ------------------------------------------------------------ map wiring

/** Overlays, banners and click handling for the battle map. */
export function battleOverlays(): void {
  const v = app.mapView;
  const b = app.battle;
  if (!v || !b) return;
  const wreckage = new Set(
    Object.keys(b.state.wreckage).filter((k) => (b.state.wreckage[k]?.length ?? 0) > 0),
  );
  const clubs = new Set(
    Object.keys(b.state.clubs).filter((k) => (b.state.clubs[k]?.length ?? 0) > 0),
  );
  const o: typeof v.overlays = { wreckage, clubs };
  const actor = b.actor;
  if (b.move && actor && b.actorPersona === null) {
    const reach = new Map<string, string>();
    const facings = new Map<string, Facing[]>();
    for (const l of b.move.landings) {
      const k = `${l.hex.col},${l.hex.row}`;
      const mp = landingMp(l);
      const prev = reach.get(k);
      if (prev === undefined || mp < Number(prev)) reach.set(k, String(mp));
      const fs = facings.get(k) ?? [];
      if (!fs.includes(l.facing)) fs.push(l.facing);
      facings.set(k, fs);
    }
    o.reachable = reach;
    o.bands = new Map([...facings].map(([k, fs]) => [k, { team: actor.team, facings: fs }]));
    const chosen = b.move.landing;
    o.selected = chosen ? keyOf(chosen.hex) : null;
    o.chosen = chosen ? { hex: keyOf(chosen.hex), facing: chosen.facing } : null;
  } else if (b.attack && actor) {
    const targets = b.fireSuggestion()?.targets ?? [];
    o.targets = new Set(targets.map((x) => keyOf(b.state.units[x.targetId]!.position)));
    const tu = b.attack.targetId ? b.state.units[b.attack.targetId] : null;
    if (tu) {
      o.target = keyOf(tu.position);
      o.los = [actor.position, tu.position];
    }
  }
  v.overlays = o;
  v.tipFor = pileTipFor(b.state);
  v.banners = battleBanners();
  const ui = app.battleUi;
  if (ui.centerPending && actor) {
    ui.centerPending = false;
    const foes = Object.values(b.state.units).filter(
      (u) => u.team !== actor.team && isUnitOnBoard(u) && !isHull(u),
    );
    v.fitHexes([actor.position, ...foes.map((u) => u.position)], clearArea(v.canvas));
  }
  const target = b.attack?.targetId ? b.state.units[b.attack.targetId] : null;
  if (ui.framePending && actor && target && b.phase === "attack") {
    ui.framePending = false;
    v.frame(actor.position, target.position, clearArea(v.canvas));
  }
  v.onPick = (hex, ev, facing) => onMapPick(hex, ev, facing);
}

const keyOf = (h: { col: number; row: number }) => `${h.col},${h.row}`;

/**
 * A map click: a movement landing first, then an attack target; any other
 * hex holding a unit opens that unit's record sheet.
 */
function onMapPick(hex: { col: number; row: number }, ev: MouseEvent, facing: Facing | null): void {
  const b = app.battle;
  if (!b) return;
  const unit = Object.values(b.state.units).find(
    (u) => isUnitOnBoard(u) && u.position.col === hex.col && u.position.row === hex.row,
  );
  const showSheet = () => {
    if (unit) openSheetFor(unit.id);
  };
  if (b.actorPersona !== null) {
    showSheet();
    return;
  }
  if (b.move) {
    const here = b.landingsAt(hex);
    if (here.length === 0) {
      showSheet();
      return;
    }
    // a facing triangle picks that landing; an unavailable one does nothing
    if (facing !== null) {
      const l = here.find((x) => x.facing === facing);
      if (l) {
        act(() => b.chooseLanding(l));
        rerender();
      }
      return;
    }
    if (here.length === 1) {
      act(() => b.chooseLanding(here[0]!));
      rerender();
      return;
    }
    openFacingMenu(here, ev);
    return;
  }
  if (b.attack && unit && b.fireSuggestion()?.targets.some((x) => x.targetId === unit.id)) {
    pickTarget(unit.id);
    return;
  }
  showSheet();
}

function openFacingMenu(here: RevealedLanding[], ev: MouseEvent): void {
  const b = app.battle!;
  const sorted = [...here].sort(
    (a, c) => FACING_ORDER.indexOf(a.facing) - FACING_ORDER.indexOf(c.facing),
  );
  const anchor = document.createElement("div");
  anchor.style.cssText = `position:fixed;left:${ev.clientX}px;top:${ev.clientY}px;width:1px;height:1px`;
  document.body.appendChild(anchor);
  kitModal.open = true;
  const arrows = A.facing;
  const angle = app.mapView?.angle ?? 0;
  void kit()
    .popupMenu(
      anchor,
      sorted.map((l) => {
        const dir = (FACING_ORDER.indexOf(l.facing) * 60 - angle + 360) % 360;
        return {
          label: `${arrows[Math.round(dir / 60) % 6]} ${fit(l.facing.toUpperCase(), 3)} ${landingMp(l)} MP${l.melee ? ` ${l.melee.kind}` : ""}`,
        };
      }),
    )
    .then((r) => {
      anchor.remove();
      kitModal.open = false;
      if (r && "index" in r) {
        const l = sorted[r.index];
        if (l) act(() => b.chooseLanding(l));
      }
      rerender();
    });
}

// ------------------------------------------------------------ battle windows

const MENU = ["menu.resume", "menu.pace", "menu.withdraw"];

/** Open the battle menu; persona play holds until it closes (`closeMenu`). */
function openMenu(cursor = 0): void {
  app.modal = { kind: "battleMenu", cursor };
  holdAi(true);
}

function closeMenu(): void {
  app.modal = null;
  holdAi(false);
}

function battleModal(): TuiNode | null {
  const m = app.modal!;
  if (m.kind === "battleMenu") {
    return modal(
      { cols: 40, title: t("menu.title"), footer: t("dialog.footer") },
      ...MENU.map((k, i) =>
        row(
          `${i === m.cursor ? A.cursor : " "} ${t(k)}${k === "menu.pace" ? `: ${t(`pace.${app.aiPace}`)}` : ""}`,
          { sel: i === m.cursor, key: k, onClick: () => runMenu(i) },
        ),
      ),
    );
  }
  if (m.kind === "policy") return policyWindow(m);
  if (m.kind === "message")
    return modal(
      { cols: 60, title: m.title },
      row(m.text),
      ...blank(1),
      row(t("key.anyKey"), { cls: "ia-dim" }),
    );
  return null;
}

function runMenu(i: number): void {
  const k = MENU[i];
  if (k === "menu.pace") {
    setAiPace(AI_PACES[(AI_PACES.indexOf(app.aiPace) + 1) % AI_PACES.length]!);
    app.modal = { kind: "battleMenu", cursor: i };
  } else if (k === "menu.withdraw") {
    // The menu closes but play stays on hold until the confirm is answered.
    app.modal = null;
    kitModal.open = true;
    void kit()
      .dialog({
        title: t("menu.withdraw"),
        text: t("withdraw.confirm"),
        buttons: [t("yes"), t("no")],
        defaultIndex: 1,
        tone: "warn",
      })
      .then((r) => {
        kitModal.open = false;
        if (r === t("yes")) {
          stopAi();
          app.battle = null;
          app.screen = "setup";
        } else holdAi(false);
        rerender();
      });
  } else closeMenu();
  rerender();
}

// ------------------------------------------------------------ keys

export function battleKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  const m = app.modal;
  if (m) {
    if (m.kind === "battleMenu") {
      if (e.key === "ArrowDown") m.cursor = (m.cursor + 1) % MENU.length;
      else if (e.key === "ArrowUp") m.cursor = (m.cursor + MENU.length - 1) % MENU.length;
      else if (e.key === "Enter") runMenu(m.cursor);
      else if (e.key === "Escape") closeMenu();
      else return false;
      return true;
    }
    // The policy dialog's kit controls keep their keys; Escape cancels it.
    if (m.kind === "policy") {
      if (e.key !== "Escape") return false;
      app.modal = null;
      return true;
    }
    app.modal = null;
    return true;
  }
  if (e.key === "Escape") openMenu();
  // [ and ] open and close the left and right record sheets; on a gamepad
  // these will be the left and right shoulder buttons.
  else if (e.key === "[") toggleSheet(0);
  else if (e.key === "]") toggleSheet(1);
  else if (e.code === "KeyL") setLogs(!app.battleUi.logs);
  else if (e.key === " " && b.actorPersona !== null) pumpAi(true);
  else if (b.actorPersona !== null) return false;
  else if (b.phase === "movement") return moveKey(e);
  else if (b.phase === "attack") return attackKey(e);
  else return false;
  return true;
}

function moveKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  const choices = b.moveChoices();
  if (e.key === "ArrowDown") app.orderCursor = (app.orderCursor + 1) % choices.length;
  else if (e.key === "ArrowUp")
    app.orderCursor = (app.orderCursor + choices.length - 1) % choices.length;
  else if (e.key === "Enter" || e.key === " ") {
    const c = choices[app.orderCursor];
    if (c && b.move?.choice !== c) act(() => b.chooseMove(c));
    else if (moveReady()) commit();
  } else if ((e.key === "F10" || e.code === "KeyD") && moveReady()) commit();
  else return false;
  return true;
}

function attackKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  const rows = attackRows();
  if (e.key === "Tab") cycleTarget(e.shiftKey ? -1 : 1);
  else if (e.code === "KeyT")
    act(() => b.setTwist(TWISTS[(TWISTS.indexOf(b.attack!.twist) + 1) % 3]!));
  else if (e.key === "ArrowDown")
    app.orderCursor = rows.length ? (app.orderCursor + 1) % rows.length : 0;
  else if (e.key === "ArrowUp")
    app.orderCursor = rows.length ? (app.orderCursor + rows.length - 1) % rows.length : 0;
  else if (e.key === " ") toggleRow(app.orderCursor);
  else if (e.code === "KeyA") act(() => b.checkAll(true));
  else if (e.code === "KeyN") act(() => b.clearAttack());
  else if (e.code === "KeyX") {
    const i = rows.findIndex((r) => r.kind !== "weapon");
    if (i >= 0) app.orderCursor = i;
  } else if (e.key === "F10" || e.code === "KeyD" || e.key === "Enter") commit();
  else return false;
  return true;
}
