/** Screen 3: the battle HUD (full map, frame, drawers, orders) and its windows. */
import { type Facing, isHull, isUnitOnBoard, type RevealedLanding } from "btlib10x";
import { ANIM_SPEEDS } from "../battle/beats";
import { largestRect, safeRects } from "../battle/camera";
import type { MoveChoice } from "../battle/controller";
import { tallies } from "../battle/victory";
import { animateOverlays, animator, battleBanners, holdAi, pumpAi, stopAi } from "../flow";
import { t } from "../i18n";
import { bracket, isLogsKey } from "../input";
import { CAMERA_MS, CLIP_MIN_FS, type MapView } from "../map/view";
import {
  AI_PACES,
  app,
  kitModal,
  reducedMotion,
  rerender,
  setAiPace,
  setAnimSpeed,
} from "../state";
import { UI_THEME } from "../theme";
import type { TuiChild, TuiNode } from "../tui";
import {
  ATTACK_W,
  act,
  attackDialog,
  attackDialogOpen,
  attackKey,
  attackKeys,
  attackPanel,
  dialogKey,
  frameTarget,
  physicalOutline,
  pickTarget,
} from "./battle.attack";
import {
  BODY,
  battleFrame,
  clipSheets,
  cycleFocus,
  doneButton,
  focusMover,
  openPolicy,
  openSheetFor,
  setLogs,
  sheetKey,
  sheetPolicy,
  toggleLogs,
  togglePin,
  toggleSheet,
} from "./battle.hud";
import { at, blank, cells, fit, h, kit, mapSlot, modal, row, span, statusbar } from "./common";
import { closesMessage } from "./menu";
import { openOptions, optionsKey, optionsWindow } from "./options";
import { pileTipFor } from "./piles";
import { policyWindow } from "./setup";

const { MARK: M, ARROW: A, GRID: G } = UI_THEME;

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
/** Id of the Hold dropdown on the mode bar, where Enter opens its menu. */
const HOLD_ID = "ia-hold";

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

/** The mode bar, left to right: the Hold dropdown (when any), then the modes that pick a hex. */
type BarItem = "hold" | MoveChoice;

function barItems(): BarItem[] {
  const choices = app.battle!.moveChoices();
  const hold: BarItem[] = choices.some((c) => STATIONARY.has(c)) ? ["hold"] : [];
  return [...hold, ...choices.filter((c) => !STATIONARY.has(c))];
}

function pickMove(c: MoveChoice): void {
  const b = app.battle!;
  app.orderCursor = Math.max(0, barItems().indexOf(STATIONARY.has(c) ? "hold" : c));
  act(() => b.chooseMove(c));
  rerender();
}

/**
 * The Hold dropdown under its bar item (a click, Enter, or ↑ ↓ on it). The
 * menu cursor starts on the held choice; `step` ±1 (↓ / ↑) starts it one
 * after or before it, round the list (nothing held: ↓ the first, ↑ the last).
 */
function openHoldMenu(el: HTMLElement | null, step = 0): void {
  if (!el) return;
  const hold = app.battle!.moveChoices().filter((c) => STATIONARY.has(c));
  const current = app.battle?.move?.choice ?? null;
  const at = hold.indexOf(current as MoveChoice);
  const n = hold.length;
  const active =
    step === 0 ? Math.max(0, at) : at < 0 ? (step > 0 ? 0 : n - 1) : (at + step + n) % n;
  kitModal.open = true;
  void kit()
    .popupMenu(
      el,
      hold.map((c) => ({
        label: `${c === current ? M.on : " "} ${fit(t(`choice.${c}`), 16)}`,
      })),
      { active },
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
  const cursor = barItems()[app.orderCursor];
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
        id: HOLD_ID,
        cls: cursor === "hold" ? "sel" : held ? "ia-bright" : "",
        onClick: (e) =>
          openHoldMenu(e.currentTarget instanceof HTMLElement ? e.currentTarget : null),
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

/**
 * The movement hint (and a melee warning) as a row of the Movement Command
 * box, which has the width the status line lacks: its width in cells, and
 * the row centred in a box `width` cells wide.
 */
function moveHint(): { width: number; row: (width: number) => TuiNode } | null {
  const b = app.battle!;
  const draft = b.move;
  if (!draft) return null;
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
  const melee = l?.melee ? ` ${t("orders.melee", { kind: l.melee.kind })}` : "";
  const used = cells(`${info}${melee}`);
  return {
    width: used + 2,
    row: (width) => {
      const left = Math.max(1, Math.floor((width - used) / 2));
      const kids: TuiChild[] = [" ".repeat(left), span(info, { cls: "ia-accent", key: "info" })];
      if (melee) kids.push(span(melee, { cls: "ia-err", key: "melee" }));
      kids.push(" ".repeat(Math.max(1, width - used - left)));
      return h().el("div", { class: "ia-row", key: "hint" }, ...kids);
    },
  };
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
        // the key focus is on a record sheet: the cursor dims
        class: app.battleUi.focus === "orders" ? "ia-menu" : "ia-menu ia-unfocused",
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
  // the map is still catching up: say what it plays, not the prompt already waiting
  const clip = animator.status;
  if (animator.busy && clip) {
    // a move or jump shows itself on the map: no box, unless paused
    const plain = clip.kind === "move" || clip.kind === "jump";
    if (plain && !animator.paused) return out([], 0, false);
    const text =
      clip.kind === "reel"
        ? t("anim.status.reel")
        : t(`anim.status.${clip.kind}`, { id: clip.unitId });
    const paused = animator.paused ? t("anim.status.paused") : "";
    const [row, w] = textRow(`${text}${paused}`, "ia-accent", "clip");
    return out([row], w, false);
  }
  if (!u) return out([], 0, false);
  if (b.actorPersona !== null) {
    const [ai, w] = textRow(t("orders.aiActing", { id: u.id }), "ia-accent", "ai");
    return out([ai], w, false);
  }
  if (b.phase === "movement") {
    const m = moveMenu();
    const hint = moveHint();
    const title = t("orders.moveTitle");
    // the whole box width (an error row may widen it), so the hint centres in it
    const width = Math.max(m.width, hint?.width ?? 0, cells(title) + 4, ...extra.map((x) => x[1]));
    return out(hint ? [...m.rows, hint.row(width)] : m.rows, width, moveReady(), title);
  }
  frameTarget();
  const panel = attackPanel(ATTACK_W);
  return out(panel.rows, panel.width, true, t("orders.attackTitle"));
}

const MOVE_KEYS: StatusKey[] = [
  ["←→", "key.mode"],
  ["Shift+←→", "key.aim"],
  ["Bksp", "key.clear"],
];
const SHEET_KEYS: StatusKey[] = [
  ["←↑↓→", "key.hint"],
  ["Bksp", "key.back"],
];
/** Status bar key names as pad buttons, once the pad was the last input. */
const PAD_NAMES: Readonly<Record<string, string>> = {
  Enter: "A",
  Bksp: "B",
  Tab: "X",
  F10: "Y",
  "[": "LB",
  "]": "RB",
  L: "View",
  Esc: "Menu",
  "←→": "D←→",
  "↑↓": "D↑↓",
  "←↑↓→": "D-pad",
  "Shift+←→": "LS",
};

function statusKeys(keys: StatusKey[]): StatusKey[] {
  if (!app.padInput) return keys;
  return keys.map(([k, label, run]) => [PAD_NAMES[k] ?? k, label, run] as StatusKey);
}

/** The orders' key hints for the focused region and the phase. */
function regionKeys(persona: boolean): StatusKey[] {
  if (app.battleUi.focus !== "orders") return SHEET_KEYS;
  if (persona) return [];
  return app.battle!.phase === "movement" ? MOVE_KEYS : attackKeys();
}

export function battleScreen(): TuiNode {
  const H = h();
  const b = app.battle!;
  const ui = app.battleUi;
  if (!animator.busy) ui.clip = null;
  // while a clip plays the HUD follows it; the next prompt's drawers wait for its end
  if (ui.clip) {
    const st = animator.status;
    clipSheets(st && st.kind !== "reel" ? st.unitId : null, st?.kind === "reel");
  } else {
    focusMover();
    sheetPolicy();
  }
  const o = orders();
  const clip = animator.busy;
  // a persona waits for Enter (A) or a click on NEXT
  const stepping = !clip && b.actorPersona !== null && app.aiPace === "step" && b.result === null;
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
  const menuKey: StatusKey = [
    "Esc",
    "key.menu",
    () => {
      openMenu();
      rerender();
    },
  ];
  return H.el(
    "div",
    { class: "ia-root ia-battle" },
    ...battleFrame(
      title(),
      [
        map,
        clip
          ? doneButton(() => skipClip(), "orders.skipButton")
          : o.done
            ? doneButton(() => commit())
            : stepping
              ? doneButton(() => pumpAi(true), "orders.stepButton")
              : null,
      ],
      o.menu.length > 0 ? [topMenu(o.menu, o.width, BODY.row, o.title)] : [],
    ),
    statusbar(
      statusKeys(
        clip
          ? [["Enter", "key.skip", () => skipClip()], menuKey]
          : [
              ...regionKeys(b.actorPersona !== null),
              // F10 closes an attack dialog instead of committing
              ...(o.done && !attackDialogOpen()
                ? [["F10", "key.done", () => commit()] as const]
                : []),
              ...(stepping ? [["Enter", "key.step", () => pumpAi(true)] as const] : []),
              ["Tab", "key.focus", () => cycleFocus(1)],
              ["[", "key.sheetLeft", () => toggleSheet(0)],
              ["]", "key.sheetRight", () => toggleSheet(1)],
              ["L", "key.logs", () => toggleLogs()],
              menuKey,
            ],
      ),
    ),
    app.modal ? battleModal() : null,
  );
}

/** SKIP (or Enter on its hint): the map jumps to the result; play goes on from there. */
function skipClip(): void {
  animator.skip();
  rerender();
}

function commit(): void {
  const b = app.battle!;
  const d = b.attack;
  if (b.phase === "attack" && d && !d.weapons.length && !d.physical.length) {
    if (!d.pickup && !d.dropClub) {
      confirmPass();
      return;
    }
  }
  act(() => (b.phase === "movement" ? b.commitMove() : b.commitAttack()));
  app.orderCursor = 0;
  pumpAi();
}

/** Done with nothing checked: ask before the attack passes (No is the default). */
function confirmPass(): void {
  kitModal.open = true;
  void kit()
    .dialog({
      title: t("orders.passTitle"),
      text: t("orders.passConfirm", { id: app.battle?.actorId ?? "" }),
      buttons: [t("yes"), t("no")],
      defaultIndex: 1,
    })
    .then((r) => {
      kitModal.open = false;
      const b = app.battle;
      if (r === t("yes") && b?.attack) {
        act(() => b.commitAttack());
        app.orderCursor = 0;
        pumpAi();
      }
      rerender();
    });
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
  v.tipFor = pileTipFor(b.state);
  v.onPick = (hex, facing) => onMapPick(hex, facing);
  v.reframe = reframe;
  // A clip on the map shows the step catching up: no prompt overlays yet.
  if (animateOverlays(v)) {
    clipCamera(v);
    v.overlays = o;
    return;
  }
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
    const melee = physicalOutline();
    o.outline = melee ? keyOf(melee) : null;
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
    // a Player's move: where it can go too
    const reach = b.move && b.actorPersona === null ? b.move.landings.map((l) => l.hex) : [];
    v.fitHexes(
      [actor.position, ...foes.map((u) => u.position), ...reach],
      largestRect(v.canvas, safeRects(v.canvas)),
    );
  }
  const target = b.attack?.targetId ? b.state.units[b.attack.targetId] : null;
  if (ui.framePending && actor && target && b.phase === "attack") {
    ui.framePending = false;
    v.frame(actor.position, target.position, largestRect(v.canvas, safeRects(v.canvas)));
  }
  // a persona's attack: shooter and target in view, moving as little as it can
  const shot = actor && target && b.phase === "attack" && b.actorPersona !== null;
  const shotKey = shot ? `${b.state.turn}:${actor.id}>${target.id}` : null;
  if (shot && shotKey !== ui.frameFor && !ui.logs) {
    ui.frameFor = shotKey;
    v.ensureVisible(
      [
        { hex: actor.position, sign: actor.id },
        { hex: target.position, sign: target.id },
      ],
      safeRects(v.canvas),
      { minFs: CLIP_MIN_FS },
    );
  }
  v.onPick = (hex, facing) => onMapPick(hex, facing);
  v.reframe = reframe;
}

/**
 * Frame the playing clip once its HUD is drawn (docs/INSTANT.md, Camera): no
 * move when it shows whole already, else pan, then zoom out; when that is not
 * enough the unpinned drawers close (after the next render), then a turn.
 * The clip waits for the camera. A reel too big to show whole frames each
 * attack in turn instead (`flow.ts`, follow).
 */
function clipCamera(v: MapView): void {
  const ui = app.battleUi;
  const c = ui.clip;
  if (!c || c.framed || c.follow || ui.logs || app.modal) return;
  const rects = safeRects(v.canvas);
  if (
    !c.collapsed &&
    ui.sheets.some((d) => d.open && !d.pinned) &&
    !v.canShow(c.needs, rects, { minFs: CLIP_MIN_FS })
  ) {
    c.collapsed = true;
    rerender();
    return;
  }
  c.framed = true;
  const ease = !reducedMotion();
  const r = v.ensureVisible(c.needs, rects, { minFs: CLIP_MIN_FS, rotate: true, ease });
  if (r.moved && ease) animator.delayStart(CAMERA_MS);
}

const keyOf = (h: { col: number; row: number }) => `${h.col},${h.row}`;

/**
 * A map click (or A on the reticle): a movement landing first, then an attack
 * target; any other hex holding a unit opens that unit's record sheet. On a
 * landing hex the map view has already picked the facing (`pickFacing`).
 */
function onMapPick(hex: { col: number; row: number }, facing: Facing | null): void {
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
    const l = here.find((x) => x.facing === facing) ?? (here.length === 1 ? here[0] : undefined);
    if (l) {
      act(() => b.chooseLanding(l));
      rerender();
    }
    return;
  }
  if (b.attack && unit && b.fireSuggestion()?.targets.some((x) => x.targetId === unit.id)) {
    pickTarget(unit.id);
    return;
  }
  showSheet();
}

// ------------------------------------------------------------ battle windows

interface BattleMenuItem {
  key: string;
  label: () => string;
  run: () => void;
  sepAbove?: boolean;
}

/**
 * Battle menu entries: Resume, Persona pace, Policies (a Player unit
 * acting), Withdraw, then Options under a separator.
 */
function menuItems(): BattleMenuItem[] {
  const b = app.battle!;
  const items: BattleMenuItem[] = [
    { key: "resume", label: () => t("menu.resume"), run: () => closeMenu() },
    {
      key: "pace",
      label: () => `${t("menu.pace")}: ${t(`pace.${app.aiPace}`)}`,
      run: () => stepPace(1),
    },
    {
      key: "anim",
      label: () => `${t("menu.anim")}: ${t(`anim.speed.${app.anim}`)}`,
      run: () => stepAnim(1),
    },
  ];
  const id = b.actorId;
  const at = items.length;
  if (id !== null && b.actorPersona === null && b.result === null)
    items.push({
      key: "policy",
      label: () => t("menu.policy", { id }),
      // play stays on hold: OK / Cancel come back to this menu
      run: () => openPolicy(id, { kind: "battleMenu", cursor: at }),
    });
  items.push(
    { key: "withdraw", label: () => t("menu.withdraw"), run: () => withdraw() },
    {
      key: "options",
      label: () => t("menu.options"),
      // closing Options comes back to this menu, play still on hold
      run: () => openOptions(app.modal),
      sepAbove: true,
    },
  );
  return items;
}

/** Open the battle menu; persona play holds until it closes (`closeMenu`). */
function openMenu(cursor = 0): void {
  app.modal = { kind: "battleMenu", cursor };
  holdAi(true);
}

function closeMenu(): void {
  app.modal = null;
  holdAi(false);
}

/** Persona pace one step along instant / step / timed, either way, round again. */
function stepPace(d: number): void {
  const n = AI_PACES.length;
  setAiPace(AI_PACES[(AI_PACES.indexOf(app.aiPace) + d + n) % n]!);
}

/** Map animations one step along full / fast / off, either way, round again. */
function stepAnim(d: number): void {
  const n = ANIM_SPEEDS.length;
  setAnimSpeed(ANIM_SPEEDS[(ANIM_SPEEDS.indexOf(app.anim) + d + n) % n]!);
  if (app.anim === "off") animator.skip();
}

const MENU_COLS = 40;

function battleModal(): TuiNode | null {
  const m = app.modal!;
  if (m.kind === "battleMenu") {
    return modal(
      { cols: MENU_COLS, title: t("menu.title"), footer: t("dialog.footer") },
      ...menuItems().flatMap((it, i) => [
        ...(it.sepAbove
          ? [row(G.th.repeat(MENU_COLS - 4), { key: `s${it.key}`, cls: "ia-dim" })]
          : []),
        row(`${i === m.cursor ? A.cursor : " "} ${it.label()}`, {
          sel: i === m.cursor,
          key: it.key,
          onClick: () => runMenu(i),
        }),
      ]),
    );
  }
  if (m.kind === "policy") return policyWindow(m);
  if (m.kind === "options") return optionsWindow(m);
  if (m.kind === "fire" || m.kind === "physical") return attackDialog(m);
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
  const it = menuItems()[i];
  // pace, animations and Options keep the menu open on their row
  if (it?.key === "pace" || it?.key === "anim" || it?.key === "options")
    app.modal = { kind: "battleMenu", cursor: i };
  it?.run();
  rerender();
}

/** Withdraw to setup, after a confirm; play stays on hold until it is answered. */
function withdraw(): void {
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
        animator.skip();
        app.battle = null;
        app.screen = "setup";
      } else holdAi(false);
      rerender();
    });
}

/**
 * Home (R3): frame the units the prompt is about, the mover and its enemies
 * or the shooter and its target, after the next render.
 */
function reframe(): void {
  const b = app.battle;
  const ui = app.battleUi;
  if (!b) return;
  if (b.phase === "attack" && b.attack?.targetId) ui.framePending = true;
  else ui.centerPending = true;
  rerender();
}

// ------------------------------------------------------------ keys

export function battleKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  const m = app.modal;
  if (m) {
    if (m.kind === "battleMenu") {
      const n = menuItems().length;
      const row = menuItems()[m.cursor]?.key;
      const pace = row === "pace";
      if (e.key === "ArrowDown") m.cursor = (m.cursor + 1) % n;
      else if (e.key === "ArrowUp") m.cursor = (m.cursor + n - 1) % n;
      else if (pace && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
        stepPace(e.key === "ArrowLeft" ? -1 : 1);
      else if (row === "anim" && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
        stepAnim(e.key === "ArrowLeft" ? -1 : 1);
      else if (e.key === "Enter" || e.key === " ") runMenu(m.cursor);
      else if (e.key === "Escape" || e.key === "Backspace") closeMenu();
      else return false;
      return true;
    }
    if (m.kind === "fire" || m.kind === "physical") return dialogKey(e);
    if (m.kind === "options") return optionsKey(e, m);
    // The policy dialog's kit controls keep their keys; Esc / Backspace cancel it.
    if (m.kind === "policy") {
      if (e.key !== "Escape" && e.key !== "Backspace") return false;
      app.modal = m.back ?? null;
      return true;
    }
    if (!closesMessage(e)) return false;
    app.modal = null;
    return true;
  }
  const select = e.key === "Enter" || e.key === " ";
  // A press just as control comes back from a persona is the end of a step burst.
  if (select && (e.repeat || performance.now() - app.playerSince < PLAYER_GRACE_MS)) return true;
  if (e.key === "Escape") openMenu();
  // Tab / Shift+Tab (X): left sheet, orders, right sheet
  else if (e.key === "Tab") cycleFocus(e.shiftKey ? -1 : 1);
  // [ and ] (LB / RB) open and close the left and right record sheets;
  // with Shift they pin and unpin them.
  else if (bracket(e) && e.shiftKey) togglePin(bracket(e) < 0 ? 0 : 1);
  else if (bracket(e)) toggleSheet(bracket(e) < 0 ? 0 : 1);
  else if (isLogsKey(e)) setLogs(!app.battleUi.logs);
  else if (sheetKey(e)) return true;
  else if (select && b.actorPersona !== null) pumpAi(true);
  else if (b.actorPersona !== null) return false;
  else if (b.phase === "movement") return moveKey(e);
  else if (b.phase === "attack" && e.key === "F10") commit();
  else if (b.phase === "attack") return attackKey(e);
  else return false;
  return true;
}

/** Enter / Space ignored this long after a persona hands control to the Player. */
const PLAYER_GRACE_MS = 300;

function moveKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  const items = barItems();
  const n = Math.max(1, items.length);
  // ← → run along the bar; ↑ ↓ open Hold one choice after / before the held one
  if (e.key === "ArrowRight") app.orderCursor = (app.orderCursor + 1) % n;
  else if (e.key === "ArrowLeft") app.orderCursor = (app.orderCursor + n - 1) % n;
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (items[app.orderCursor] === "hold")
      openHoldMenu(document.getElementById(HOLD_ID), e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" || e.key === " ") {
    // Hold opens its dropdown; choosing a mode never commits, another drops the landing
    const c = items[app.orderCursor];
    if (c === "hold") openHoldMenu(document.getElementById(HOLD_ID));
    else if (c && b.move?.choice !== c) act(() => b.chooseMove(c));
  } else if (e.key === "Backspace") {
    if (b.move?.landing) act(() => b.clearLanding());
  } else if (e.key === "F10" && moveReady()) commit();
  else return false;
  return true;
}
