/**
 * Attack Command: the orders panel of the attack phase (Twist, Weapon Target,
 * the weapon and physical buttons, Club, heat) and the two check-box dialogs
 * the buttons open.
 */
import {
  type FireTarget,
  heatDissipation,
  hitProbability,
  mechDefFor,
  type Twist,
  weaponDefFor,
} from "btlib10x";
import type { ClubAction, PhysicalOption } from "../battle/controller";
import { locName, t } from "../i18n";
import { type AttackDialog, type AttackPanelRow, app, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiChild, TuiNode } from "../tui";
import { sheetSideOf } from "./battle.hud";
import { cells, fit, h, row, span } from "./common";

const { MARK: M, ARROW: A, GRID: G } = UI_THEME;

export const ATTACK_W = 45;
const DIALOG_W = 48;
/** Twists from left to right, as the Twist row shows them and ← → step them. */
const SIDEWAYS: Twist[] = ["leftSide", "front", "rightSide"];

function setError(e: unknown): void {
  app.error = e instanceof Error ? e.message : String(e);
}

export function act(fn: () => void): void {
  try {
    fn();
    app.error = null;
  } catch (e) {
    setError(e);
  }
}

// ------------------------------------------------------------ targets

function currentTarget(): FireTarget | null {
  const b = app.battle!;
  const id = b.attack?.targetId;
  return b.fireSuggestion()?.targets.find((x) => x.targetId === id) ?? null;
}

function cycleTarget(dir: number): void {
  const b = app.battle!;
  const list = b.fireSuggestion()?.targets ?? [];
  if (list.length === 0) return;
  const i = list.findIndex((x) => x.targetId === b.attack?.targetId);
  const next = list[(i + dir + list.length) % list.length]!;
  pickTarget(next.targetId);
}

/** Aim the weapons at a unit and show its record sheet in the right drawer. */
export function pickTarget(id: string): void {
  const b = app.battle!;
  act(() => b.setTarget(id));
  showTargetSheet();
  rerender();
}

/** The weapon target's sheet in the right drawer, once per new target. */
export function showTargetSheet(): void {
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

// ------------------------------------------------------------ panel rows

/** The panel's rows, top to bottom, without the hidden ones. */
function panelRows(): AttackPanelRow[] {
  const b = app.battle!;
  const rows: AttackPanelRow[] = ["twist", "target"];
  if (currentTarget()) rows.push("weapons");
  if (b.physicalOptions().length > 0) rows.push("physical");
  if (b.clubActions().length > 0) rows.push("club");
  return rows;
}

/** Picking up a club is the turn's only action (TW p.146): both buttons go dim. */
function busy(): boolean {
  return app.battle!.attack?.pickup != null;
}

function selectable(r: AttackPanelRow): boolean {
  return !((r === "weapons" || r === "physical") && busy());
}

function cursorFor(): string {
  const b = app.battle!;
  return `${b.state.turn}>${b.actorId}`;
}

/** The row under the cursor: the last one picked for this actor, else the first button. */
export function cursorRow(): AttackPanelRow {
  const rows = panelRows().filter(selectable);
  const c = app.battleUi.attackRow;
  if (c && c.for === cursorFor() && rows.includes(c.row)) return c.row;
  return (["weapons", "physical", "target"] as const).find((r) => rows.includes(r)) ?? "target";
}

function setCursor(r: AttackPanelRow): void {
  app.battleUi.attackRow = { for: cursorFor(), row: r };
}

// ------------------------------------------------------------ dialog rows

/** A dialog row: checkable when `reason` is null, else a `-` row showing why not. */
interface WeaponRow {
  readonly weaponIndex: number;
  readonly reason: string | null;
}
interface PhysicalRow {
  readonly opt: PhysicalOption;
  readonly reason: string | null;
}

/** Every weapon against the weapon target: the fireable ones first, then the blocked ones. */
function weaponRows(): WeaponRow[] {
  const b = app.battle!;
  const target = currentTarget();
  if (!target) return [];
  return [
    ...target.weapons.map((w) => {
      const c = b.weaponConflict(w.weaponIndex);
      return { weaponIndex: w.weaponIndex, reason: c ? t(`block.${c}`) : null };
    }),
    ...target.blocked.map((w) => ({ weaponIndex: w.weaponIndex, reason: t(`block.${w.reason}`) })),
  ];
}

/**
 * The legal physical attacks against every adjacent enemy, the weapon
 * target's first; one that conflicts with what is checked shows why.
 */
function physicalRows(): PhysicalRow[] {
  const b = app.battle!;
  const first = b.attack?.targetId;
  const rank = (o: PhysicalOption) => (o.decl.targetId === first ? "" : o.decl.targetId);
  return [...b.physicalOptions()]
    .sort((x, y) => (rank(x) < rank(y) ? -1 : rank(x) > rank(y) ? 1 : 0))
    .map((opt) => {
      const c = b.physicalConflict(opt.decl);
      return { opt, reason: c ? t(`physNo.${c}`) : null };
    });
}

function dialogRows(kind: AttackDialog["kind"]): readonly { reason: string | null }[] {
  return kind === "fire" ? weaponRows() : physicalRows();
}

const available = (rows: readonly { reason: string | null }[]) =>
  rows.filter((r) => r.reason === null).length;

function openDialog(kind: AttackDialog["kind"]): void {
  const rows = dialogRows(kind);
  app.modal = { kind, cursor: rows.findIndex((r) => r.reason === null) };
  rerender();
}

function closeDialog(): void {
  app.modal = null;
  rerender();
}

// ------------------------------------------------------------ the panel

function clubLabel(a: ClubAction): string {
  if (a === "none") return t("orders.clubNone");
  if (a === "drop") return t("orders.clubDrop");
  return t("orders.clubPickup", { source: t(`club.${a}`) });
}

function cycleClub(dir: number): void {
  const b = app.battle!;
  const list = b.clubActions();
  if (list.length === 0) return;
  const i = list.indexOf(b.clubAction());
  act(() => b.setClubAction(list[(i + dir + list.length) % list.length]!));
}

/** The Twist row's Enter: one twist to the right (Left, Front, Right), round again. */
function cycleTwist(): void {
  const b = app.battle!;
  act(() => b.setTwist(SIDEWAYS[(SIDEWAYS.indexOf(b.attack!.twist) + 1) % 3]!));
}

/** ← → twist toward that side, stopping at the full twist. */
function twistToward(d: number): void {
  const b = app.battle!;
  const i = SIDEWAYS.indexOf(b.attack!.twist) + d;
  const to = SIDEWAYS[Math.max(0, Math.min(2, i))]!;
  if (to !== b.attack!.twist) act(() => b.setTwist(to));
}

/** The weapon heat of the checked weapons. */
function fireHeat(): number {
  const b = app.battle!;
  const def = mechDefFor(b.actor!);
  return b.attack!.weapons.reduce((n, w) => n + (weaponDefFor(def.weapons[w]!).heat ?? 0), 0);
}

/** The panel's rows and its width: `minWidth`, or wider for a long button caption. */
export function attackPanel(minWidth: number): { rows: TuiNode[]; width: number } {
  const b = app.battle!;
  const draft = b.attack!;
  const unit = b.actor!;
  const def = mechDefFor(unit);
  const sugg = b.fireSuggestion();
  const target = currentTarget();
  const cur = cursorRow();
  const rows = panelRows();
  const weaponsText = busy()
    ? t("orders.noWeaponsPickup")
    : t("orders.weaponsButton", { n: draft.weapons.length, m: available(weaponRows()) });
  const physText = busy()
    ? t("orders.noPhysPickup")
    : t("orders.physButton", { n: draft.physical.length, m: available(physicalRows()) });
  const width = Math.max(
    minWidth,
    rows.includes("weapons") ? cells(weaponsText) + 4 : 0,
    rows.includes("physical") ? cells(physText) + 4 : 0,
  );
  const lw =
    Math.max(cells(t("orders.twist")), cells(t("orders.weaponTarget")), cells(t("orders.club"))) +
    1;
  const label = (key: string) => `${fit(t(key), lw)}`;
  const sel = (r: AttackPanelRow) => cur === r;
  const click = (r: AttackPanelRow, run: () => void) => () => {
    if (!selectable(r)) return;
    setCursor(r);
    run();
    rerender();
  };
  // Left / Front / Right, each a click target
  const twistKids: TuiChild[] = [label("orders.twist")];
  for (const x of SIDEWAYS)
    twistKids.push(
      " ",
      span(`${draft.twist === x ? `(${M.on})` : "( )"} ${t(`twist.${x}`)}`, {
        key: x,
        onClick: click("twist", () => act(() => b.setTwist(x))),
      }),
    );
  const tu = target ? b.state.units[target.targetId] : null;
  const targetLine = tu
    ? `${A.prev} ${tu.id} ${tu.model} ${M.sep} ${t("orders.hexes", { n: target!.distance })} ${A.next}`
    : sugg && sugg.targets.length === 0
      ? t("orders.noTargets")
      : t("orders.pickTarget");
  const out: TuiNode[] = [
    h().el("div", { class: `ia-row${sel("twist") ? " sel" : ""}`, key: "twist" }, ...twistKids),
    row(fit(`${label("orders.weaponTarget")}${targetLine}`, width), {
      key: "target",
      cls: "ia-bright",
      sel: sel("target"),
      onClick: click("target", () => cycleTarget(1)),
    }),
  ];
  const button = (r: "weapons" | "physical", text: string) =>
    row(fit(busy() ? text : `[ ${text} ]`, width), {
      key: r,
      cls: busy() ? "ia-dim" : "",
      sel: sel(r),
      onClick: click(r, () => openDialog(r === "weapons" ? "fire" : "physical")),
    });
  if (rows.includes("weapons")) out.push(button("weapons", weaponsText));
  if (rows.includes("physical")) out.push(button("physical", physText));
  if (rows.includes("club"))
    out.push(
      row(fit(`${label("orders.club")}${A.prev} ${clubLabel(b.clubAction())} ${A.next}`, width), {
        key: "club",
        sel: sel("club"),
        onClick: click("club", () => cycleClub(1)),
      }),
    );
  const now = unit.heat + unit.heatPending;
  const heat = fireHeat();
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
  return { rows: out, width };
}

/** The panel's keys: ↑ ↓ rows, ← → twist / target / club, Enter steps or opens. */
export function attackKey(e: KeyboardEvent): boolean {
  const rows = panelRows().filter(selectable);
  const cur = cursorRow();
  const n = rows.length;
  const move = (d: number) => setCursor(rows[(rows.indexOf(cur) + d + n) % n]!);
  const side = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (side) {
    if (cur === "target") cycleTarget(side);
    else if (cur === "club") cycleClub(side);
    else twistToward(side);
  } else if (e.key === "ArrowDown") move(1);
  else if (e.key === "ArrowUp") move(-1);
  else if (e.key === "Enter" || e.key === " ") {
    if (cur === "twist") cycleTwist();
    else if (cur === "target") cycleTarget(1);
    else if (cur === "club") cycleClub(1);
    else openDialog(cur === "weapons" ? "fire" : "physical");
  } else return false;
  return true;
}

export function attackDialogOpen(): boolean {
  return app.modal?.kind === "fire" || app.modal?.kind === "physical";
}

/** Status bar keys for the panel row under the cursor, or for an open dialog. */
export function attackKeys(): (readonly [string, string])[] {
  if (attackDialogOpen())
    return [
      ["↑↓", "key.row"],
      ["Enter", "key.check"],
      ["Bksp", "key.close"],
    ];
  const cur = cursorRow();
  const side = cur === "target" ? "key.target" : cur === "club" ? "key.club" : "key.twist";
  const enter =
    cur === "weapons" || cur === "physical" ? "key.open" : cur === "twist" ? "key.twist" : side;
  return [
    ["↑↓", "key.row"],
    ["←→", side],
    ["Enter", enter],
  ];
}

// ------------------------------------------------------------ the dialogs

const cols = (tn: string, hit: string, dmg: string) =>
  `${fit(tn, 3, "right")}${fit(hit, 5, "right")}${fit(dmg, 5, "right")}`;

function weaponDialogRows(cursor: number): TuiNode[] {
  const b = app.battle!;
  const draft = b.attack!;
  const def = mechDefFor(b.actor!);
  const target = currentTarget();
  return weaponRows().map((r, i) => {
    const mount = def.weapons[r.weaponIndex]!;
    const head = `${fit(mount.weapon, 13)}${fit(locName(mount.location), 4)}`;
    if (r.reason !== null)
      return row(fit(`  -  ${head} ${r.reason}`, DIALOG_W - 4), {
        cls: "dim",
        key: `b${r.weaponIndex}`,
      });
    const fw = target!.weapons.find((w) => w.weaponIndex === r.weaponIndex)!;
    const checked = draft.weapons.includes(r.weaponIndex);
    const dmg = fw.cluster
      ? `${fw.cluster.shots}${M.times}${fw.cluster.perMissile}`
      : String(Math.round(fw.expectedDamage * 10) / 10);
    const hit = `${Math.round(hitProbability(fw.tn) * 100)}%`;
    return row(
      ` ${checked ? "[x]" : "[ ]"} ${head}${cols(String(fw.tn), hit, dmg)}${fit(fw.heat, 4, "right")}`,
      {
        sel: i === cursor,
        key: `w${r.weaponIndex}`,
        cls: checked ? "hot" : "",
        onClick: () => toggleDialogRow(i),
      },
    );
  });
}

function physicalDialogRows(cursor: number): TuiNode[] {
  const draft = app.battle!.attack!;
  return physicalRows().map((r, i) => {
    const d = r.opt.decl;
    const name = d.type === "strike" && d.weapon ? d.weapon : t(`phys.${d.type}`);
    const head = `${fit(name, 13)}${fit(d.limb ? locName(d.limb) : "-", 4)}`;
    const key = `p${d.type}${d.targetId}${d.limb ?? ""}`;
    if (r.reason !== null)
      return row(fit(`  -  ${head} ${fit(r.reason, 14)}${d.targetId}`, DIALOG_W - 4), {
        cls: "dim",
        key,
      });
    const checked = draft.physical.some(
      (p) => p.type === d.type && p.targetId === d.targetId && p.limb === d.limb,
    );
    const hit = `${Math.round(hitProbability(r.opt.toHit) * 100)}%`;
    return row(
      ` ${checked ? "[x]" : "[ ]"} ${head}${cols(String(r.opt.toHit), hit, String(r.opt.damage))}  ${d.targetId}`,
      { sel: i === cursor, key, cls: checked ? "hot" : "", onClick: () => toggleDialogRow(i) },
    );
  });
}

/** The open weapon or physical dialog, over the map; a click outside it closes it. */
export function attackDialog(m: AttackDialog): TuiNode {
  const b = app.battle!;
  const draft = b.attack!;
  const w = DIALOG_W - 4;
  const fire = m.kind === "fire";
  const tu = draft.targetId ? b.state.units[draft.targetId] : null;
  const dist = currentTarget()?.distance ?? 0;
  const title = fire
    ? t("dialog.fireTitle", {
        target: `${tu?.id ?? ""} ${tu?.model ?? ""} ${M.sep} ${t("orders.hexes", { n: dist })}`,
      })
    : t("dialog.physTitle");
  const header = fire
    ? `     ${fit(t("mech.weapon"), 13)}${fit(t("mech.loc"), 4)}${cols("TN", t("orders.hit"), t("mech.dmg"))}${fit(t("mech.heat"), 4, "right")}`
    : `     ${fit(t("mech.attack"), 13)}${fit(t("mech.loc"), 4)}${cols("TN", t("orders.hit"), t("mech.dmg"))}  ${t("mech.target")}`;
  const rows = dialogRows(m.kind);
  const n = fire ? draft.weapons.length : draft.physical.length;
  const count = fire
    ? t("dialog.fireCount", { n, m: available(rows), heat: fireHeat() })
    : t("dialog.selected", { n, m: available(rows) });
  const kids: TuiNode[] = [
    row(fit(header, w), { cls: "ia-dim", key: "th" }),
    ...(fire ? weaponDialogRows(m.cursor) : physicalDialogRows(m.cursor)),
    row(G.th.repeat(w), { cls: "ia-dim", key: "sep" }),
    row(fit(` ${count}`, w), { key: "count" }),
  ];
  if (!fire) {
    // the target ids of the Target column, with their models
    const ids = [...new Set(physicalRows().map((r) => r.opt.decl.targetId))];
    const legend = ids.map((id) => `${id} ${b.state.units[id]?.model ?? ""}`).join("   ");
    kids.push(row(fit(` ${legend}`, w), { cls: "ia-dim", key: "legend" }));
  }
  const close = `[ ${t("dialog.close")} ]`;
  kids.push(
    row(fit(`${" ".repeat(Math.max(0, Math.floor((w - cells(close)) / 2)))}${close}`, w), {
      cls: "ia-bright",
      key: "close",
      onClick: () => closeDialog(),
    }),
  );
  return h().el(
    "div",
    {
      class: "ia-modal",
      key: "modal",
      onClick: (e: MouseEvent) => {
        if (e.target === e.currentTarget) closeDialog();
      },
    },
    h().window({ border: "double", shadow: true, cols: DIALOG_W, title }, ...kids),
  );
}

function toggleDialogRow(i: number): void {
  const b = app.battle!;
  const m = app.modal;
  if (m?.kind !== "fire" && m?.kind !== "physical") return;
  if (m.kind === "fire") {
    const r = weaponRows()[i];
    if (!r || r.reason !== null) return;
    act(() => b.toggleWeapon(r.weaponIndex));
  } else {
    const r = physicalRows()[i];
    if (!r || r.reason !== null) return;
    act(() => b.togglePhysical(r.opt.decl));
  }
  m.cursor = i;
  rerender();
}

/**
 * The dialog's keys: ↑ ↓ through the rows that can be checked (`-` rows are
 * skipped), Enter / Space check one and go on to the next (A A A fires a
 * volley), Esc / Backspace / F10 close it, the checks kept.
 */
export function dialogKey(e: KeyboardEvent): boolean {
  const m = app.modal;
  if (m?.kind !== "fire" && m?.kind !== "physical") return false;
  const rows = dialogRows(m.kind);
  const n = rows.length;
  const step = (d: number) => {
    for (let j = 1; j <= n; j++) {
      const i = (((m.cursor + d * j) % n) + n) % n;
      if (rows[i]!.reason === null) {
        m.cursor = i;
        return;
      }
    }
  };
  if (e.key === "ArrowDown") step(1);
  else if (e.key === "ArrowUp") step(-1);
  else if (e.key === "Enter" || e.key === " ") {
    const i = m.cursor;
    if (rows[i]?.reason !== null) return true;
    toggleDialogRow(i);
    // checking a row can block others: look again
    const next = dialogRows(m.kind).findIndex((r, j) => j > i && r.reason === null);
    if (next >= 0) m.cursor = next;
  } else if (e.key === "Escape" || e.key === "Backspace" || e.key === "F10") closeDialog();
  else if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
  return true;
}

/** The hex of the physical row under the dialog cursor, outlined on the map. */
export function physicalOutline(): { col: number; row: number } | null {
  const m = app.modal;
  if (m?.kind !== "physical") return null;
  const id = physicalRows()[m.cursor]?.opt.decl.targetId;
  return id ? (app.battle!.state.units[id]?.position ?? null) : null;
}
