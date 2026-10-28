/** Screen 3: the battle HUD (map, unit card, orders, log) and its windows. */
import {
  type Facing,
  type FireTarget,
  heatDissipation,
  hitProbability,
  isUnitOnBoard,
  mechDefFor,
  type PhysicalAttackDecl,
  type RevealedLanding,
  type Twist,
  type UnitState,
  weaponDefFor,
} from "btlib10x";
import type { MoveChoice } from "../battle/controller";
import { tallies } from "../battle/victory";
import { battleBanners, pumpAi, stopAi } from "../flow";
import { locName, t } from "../i18n";
import { type AttackRow, app, kitModal, rerender } from "../state";
import type { TuiNode } from "../tui";
import { blank, fit, h, kit, logView, mapSlot, modal, row, statusbar } from "./common";
import { helpWindow } from "./setup";

const SIDE_W = { movement: 29, attack: 45 } as const;
const TWISTS: Twist[] = ["front", "leftSide", "rightSide"];
const CHOICE_KEY: Partial<Record<MoveChoice, string>> = {
  standStill: "S",
  walk: "W",
  run: "R",
  jump: "J",
  standupStill: "U",
  proneTurn: "P",
  shutdown: "X",
  eject: "E",
};
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

// ------------------------------------------------------------ unit card

function bar(value: number, max: number, cells: number): string {
  const n = Math.max(0, Math.min(cells, Math.round((value / Math.max(1, max)) * cells)));
  return "█".repeat(n) + "░".repeat(cells - n);
}

function unitCard(u: UnitState, width: number, compact = false): TuiNode[] {
  const def = mechDefFor(u);
  const a = u.damage.armor;
  const r = u.damage.armorRear;
  const heat = u.heat + u.heatPending;
  const pilot = "■".repeat(u.pilotHits) + "□".repeat(Math.max(0, u.pilotHitMax - u.pilotHits));
  const status = [u.prone ? t("card.prone") : "", u.shutdown !== "not" ? t("card.off") : ""]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `${t("card.heat")} ${bar(heat, 30, 10)} ${fit(heat, 2, "right")} ${t("card.sinks", { n: heatDissipation(def, u.damage, u.critSlotsDestroyed) })}`,
    `MP W${def.walking} R${def.running} J${def.jumping}  G${u.gunnery} P${u.piloting}`,
    `${t("card.pilot")} ${pilot} ${status}`,
    `HD${fit(a.head, 3, "right")} LA${fit(a.leftArm, 3, "right")} LT${fit(a.leftTorso, 3, "right")} CT${fit(a.centerTorso, 3, "right")}`,
    `RT${fit(a.rightTorso, 3, "right")} RA${fit(a.rightArm, 3, "right")} LL${fit(a.leftLeg, 3, "right")} RL${fit(a.rightLeg, 3, "right")}`,
    `${t("card.rear")} ${r.leftTorso}/${r.centerTorso}/${r.rightTorso}`,
  ];
  const shown = compact ? [lines[0]!, `${lines[1]!}  ${lines[2]!}`] : lines;
  return shown.map((l, i) => row(fit(l, width), { key: `card${i}` }));
}

// ------------------------------------------------------------ movement orders

function landingMp(l: RevealedLanding): number {
  return l.path.reduce((n, s) => n + s.baseMp, 0);
}

function moveOrders(width: number): TuiNode[] {
  const b = app.battle!;
  const choices = b.moveChoices();
  const draft = b.move!;
  const rows = choices.map((c, i) => {
    const on = draft.choice === c;
    const mp = b.budgetFor(c);
    const label = `${on ? "(•)" : "( )"} ${fit(t(`choice.${c}`), width - 14)} ${fit(CHOICE_KEY[c] ?? "", 2)}${fit(mp > 0 ? `${mp} MP` : "", 6, "right")}`;
    return row(label, {
      sel: i === app.orderCursor,
      key: c,
      onClick: () => {
        app.orderCursor = i;
        act(() => b.chooseMove(c));
      },
    });
  });
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
  return [
    ...rows,
    ...blank(1),
    row(fit(info, width), { cls: "ia-accent", key: "info" }),
    ...(l?.melee
      ? [
          row(fit(t("orders.melee", { kind: l.melee.kind }), width), {
            cls: "ia-err",
            key: "melee",
          }),
        ]
      : []),
  ];
}

// ------------------------------------------------------------ attack orders

export function attackRows(): AttackRow[] {
  const b = app.battle!;
  const draft = b.attack!;
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
  void draft;
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
  const twist = TWISTS.map((x) => `${draft.twist === x ? "(•)" : "( )"} ${t(`twist.${x}`)}`).join(
    " ",
  );
  const tu = target ? b.state.units[target.targetId] : null;
  const targetLine = tu
    ? `◂ ${tu.id} ${tu.model} · ${t("orders.hexes", { n: target!.distance })} ▸`
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
      ` ${fit("", 3)} # ${fit(t("mech.weapon"), 13)}${fit(t("mech.loc"), 3)}${fit("TN", 3, "right")}${fit(t("orders.hit"), 5, "right")}${fit(t("mech.dmg"), 5, "right")}${fit(t("mech.heat"), 4, "right")}`,
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
          ? `${fw.cluster.shots}×${fw.cluster.perMissile}`
          : String(Math.round(fw.expectedDamage * 10) / 10);
        list.push(
          row(
            ` ${checked ? "[x]" : "[ ]"} ${fit(r.weaponIndex, 1)} ${fit(mount.weapon, 13)}${fit(locName(mount.location), 3)}${fit(fw.tn, 3, "right")}${fit(`${Math.round(hitProbability(fw.tn) * 100)}%`, 5, "right")}${fit(dmg, 5, "right")}${fit(fw.heat, 4, "right")}`,
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
              `  -  ${r.weaponIndex} ${fit(mount.weapon, 13)}${fit(locName(mount.location), 3)} ${t(`block.${why}`)}`,
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
    ...blank(1),
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
  act(() => b.setTarget(next.targetId));
  app.orderCursor = 0;
  rerender();
}

// ------------------------------------------------------------ screen

function header(): string {
  const b = app.battle!;
  const u = b.actor;
  const who = u ? `${u.id} ${u.model} (${b.actorPersona ? t("ctl.ai") : t("ctl.player")})` : "";
  return t("battle.title", { turn: b.state.turn, phase: t(`phase.${b.phase}`), who });
}

function modeLine(): string {
  const b = app.battle!;
  const s = tallies(b.state, b.totals);
  if (b.mode.kind === "damageRace") {
    return t("battle.race", {
      turn: Math.min(b.state.turn, b.mode.turns),
      n: b.mode.turns,
      a: s[0]!.dealt,
      b: s[1]!.dealt,
    });
  }
  return t("battle.destroyAll", { a: s[0]!.units - s[0]!.lost, b: s[1]!.units - s[1]!.lost });
}

export function battleScreen(): TuiNode {
  const H = h();
  const b = app.battle!;
  const phase = b.phase === "attack" ? "attack" : "movement";
  const w = SIDE_W[phase];
  const u = b.actor;
  const side: TuiNode[] = [];
  if (u) side.push(...unitCard(u, w - 2, phase === "attack"));
  side.push(row("─".repeat(w - 2), { cls: "ia-dim", key: "sep" }));
  if (u && b.actorPersona !== null) {
    side.push(row(fit(t("orders.aiActing", { id: u.id }), w - 2), { cls: "ia-accent", key: "ai" }));
    if (app.aiPace === "step")
      side.push(row(fit(t("orders.aiStep"), w - 2), { cls: "ia-dim", key: "ais" }));
  } else if (u) {
    side.push(...(phase === "movement" ? moveOrders(w - 2) : attackOrders(w - 2)));
    side.push(
      ...blank(1),
      H.el(
        "div",
        { key: "btns", class: "ia-row" },
        H.btn({ onClick: () => commit() }, t("orders.done")),
        " ",
        H.btn({ onClick: () => clear() }, t("orders.clear")),
      ),
    );
  }
  if (app.error) side.push(row(fit(`! ${app.error}`, w - 2), { cls: "ia-err", key: "err" }));
  return H.el(
    "div",
    { class: "ia-root" },
    H.split(
      { cols: 100, rows: 31, border: "double", dir: "v", sizes: "24 1fr" },
      H.pane(
        { title: `${header()} · ${modeLine()}` },
        H.split(
          { sizes: `1fr ${w}` },
          H.pane({ pad: 0 }, mapSlot()),
          H.pane(u ? `${u.id} ${u.model}` : "", ...side),
        ),
      ),
      H.pane(t("battle.log"), logView(b.log, 4, 96)),
    ),
    statusbar(
      phase === "movement"
        ? [
            ["WRJS", "key.mode"],
            ["Mouse", "key.clickHex"],
            ["D", "key.done"],
            ["^Z", "key.undo"],
            ["F2", "key.menu"],
          ]
        : [
            ["Tab", "key.target"],
            ["T", "key.twist"],
            ["Spc/1-9", "key.weapon"],
            ["A/N", "key.allNone"],
            ["D", "key.done"],
            ["F2", "key.menu"],
          ],
      t("key.view"),
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

function clear(): void {
  const b = app.battle!;
  act(() => (b.phase === "movement" ? b.clearMove() : b.clearAttack()));
  rerender();
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
  v.banners = battleBanners();
  v.onPick = (hex, ev, facing) => onMapPick(hex, ev, facing);
}

const keyOf = (h: { col: number; row: number }) => `${h.col},${h.row}`;

function onMapPick(hex: { col: number; row: number }, ev: MouseEvent, facing: Facing | null): void {
  const b = app.battle;
  if (!b || b.actorPersona !== null) return;
  if (b.move) {
    const here = b.landingsAt(hex);
    if (here.length === 0) return;
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
  if (b.attack) {
    const unit = Object.values(b.state.units).find(
      (u) => isUnitOnBoard(u) && u.position.col === hex.col && u.position.row === hex.row,
    );
    if (unit && b.fireSuggestion()?.targets.some((x) => x.targetId === unit.id)) {
      act(() => b.setTarget(unit.id));
      app.orderCursor = 0;
      rerender();
    }
  }
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
  const arrows = ["↑", "↗", "↘", "↓", "↙", "↖"];
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

const MENU = [
  "menu.resume",
  "menu.sheet",
  "menu.log",
  "menu.undo",
  "menu.pace",
  "menu.help",
  "menu.withdraw",
];

function battleModal(): TuiNode | null {
  const m = app.modal!;
  const b = app.battle!;
  if (m.kind === "battleMenu") {
    return modal(
      { cols: 40, title: t("menu.title"), footer: t("dialog.footer") },
      ...MENU.map((k, i) =>
        row(
          `${i === m.cursor ? "▸" : " "} ${t(k)}${k === "menu.pace" ? `: ${t(`pace.${app.aiPace}`)}` : ""}`,
          { sel: i === m.cursor, key: k, onClick: () => runMenu(i) },
        ),
      ),
    );
  }
  if (m.kind === "sheet") {
    const u = b.state.units[m.unitId];
    if (!u) return null;
    const def = mechDefFor(u);
    const lines: string[] = [];
    lines.push(
      `${u.id}  ${def.model} ${def.name}  ${def.tonnage} t  ${t(`ctl.${b.control[u.id] ? "ai" : "player"}`)}`,
    );
    lines.push(
      `${t("card.heat")} ${u.heat}  ${t("card.pilot")} ${u.pilotHits}/${u.pilotHitMax}  G${u.gunnery} P${u.piloting}  ${u.prone ? t("card.prone") : ""} ${u.shutdown !== "not" ? t("card.off") : ""}`,
    );
    lines.push("");
    lines.push(
      `${fit(t("sheet.loc"), 6)}${fit(t("sheet.armor"), 8, "right")}${fit(t("sheet.rear"), 6, "right")}${fit(t("sheet.structure"), 10, "right")}`,
    );
    for (const loc of [
      "head",
      "centerTorso",
      "leftTorso",
      "rightTorso",
      "leftArm",
      "rightArm",
      "leftLeg",
      "rightLeg",
    ] as const) {
      const rear =
        loc === "centerTorso" || loc === "leftTorso" || loc === "rightTorso"
          ? String(u.damage.armorRear[loc])
          : "";
      lines.push(
        `${fit(locName(loc), 6)}${fit(u.damage.armor[loc], 8, "right")}${fit(rear, 6, "right")}${fit(u.damage.internalStructure[loc], 10, "right")}`,
      );
    }
    lines.push("");
    Object.entries(def.weapons).forEach(([n, w]) => {
      const jam = u.jammedWeapons.includes(Number(n)) ? " [J]" : "";
      lines.push(
        `${fit(n, 2, "right")} ${fit(w.weapon + (w.rearFacing ? " (R)" : ""), 22)}${fit(locName(w.location), 4)}${jam}`,
      );
    });
    return modal(
      { cols: 64, title: t("sheet.title"), footer: t("key.anyKey") },
      ...lines.slice(0, 26).map((l, i) => row(fit(l, 60), { key: `s${i}` })),
    );
  }
  if (m.kind === "log") {
    return modal(
      { cols: 98, rows: 29, title: t("battle.log"), footer: t("key.anyKey") },
      logView(b.log, 26, 94),
    );
  }
  if (m.kind === "help") return helpWindow();
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
  const b = app.battle!;
  const k = MENU[i];
  app.modal = null;
  if (k === "menu.sheet") {
    const id = b.actor?.id ?? Object.keys(b.state.units)[0];
    if (id) app.modal = { kind: "sheet", unitId: id };
  } else if (k === "menu.log") app.modal = { kind: "log" };
  else if (k === "menu.undo") undo();
  else if (k === "menu.pace") {
    const paces = ["instant", "step", "timed"] as const;
    app.aiPace = paces[(paces.indexOf(app.aiPace) + 1) % 3]!;
    app.modal = { kind: "battleMenu", cursor: i };
  } else if (k === "menu.help") app.modal = { kind: "help" };
  else if (k === "menu.withdraw") {
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
        }
        rerender();
      });
  }
  rerender();
}

function undo(): void {
  const b = app.battle!;
  stopAi();
  act(() => b.undo());
  app.orderCursor = 0;
  rerender();
}

// ------------------------------------------------------------ keys

export function battleKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  const v = app.mapView;
  const m = app.modal;
  if (m) {
    if (m.kind === "battleMenu") {
      if (e.key === "ArrowDown") m.cursor = (m.cursor + 1) % MENU.length;
      else if (e.key === "ArrowUp") m.cursor = (m.cursor + MENU.length - 1) % MENU.length;
      else if (e.key === "Enter") runMenu(m.cursor);
      else if (e.key === "Escape" || e.key === "F2") app.modal = null;
      else return false;
      return true;
    }
    if (m.kind === "sheet" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const ids = Object.keys(b.state.units);
      const i = ids.indexOf(m.unitId);
      m.unitId = ids[(i + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]!;
      return true;
    }
    app.modal = null;
    return true;
  }
  // map view (never hexes)
  if (v) {
    const view: Record<string, () => void> = {
      ",": () => v.rotate(-1),
      ".": () => v.rotate(1),
      "+": () => v.zoom(2),
      "=": () => v.zoom(2),
      "-": () => v.zoom(-2),
      Home: () => v.reset(),
    };
    const fn = view[e.key] ?? (e.code === "KeyV" ? () => v.cycleTilt() : undefined);
    if (fn) {
      fn();
      return true;
    }
  }
  if (e.key === "F2") app.modal = { kind: "battleMenu", cursor: 0 };
  else if (e.key === "F1") app.modal = { kind: "help" };
  else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") undo();
  else if (e.code === "KeyI")
    app.modal = { kind: "sheet", unitId: b.actor?.id ?? Object.keys(b.state.units)[0]! };
  else if (e.code === "KeyL") app.modal = { kind: "log" };
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
  const byLetter = Object.entries(CHOICE_KEY).find(
    ([c, k]) => `Key${k}` === e.code && choices.includes(c as MoveChoice),
  );
  if (byLetter) {
    const c = byLetter[0] as MoveChoice;
    app.orderCursor = choices.indexOf(c);
    act(() => b.chooseMove(c));
  } else if (e.key === "ArrowDown") app.orderCursor = (app.orderCursor + 1) % choices.length;
  else if (e.key === "ArrowUp")
    app.orderCursor = (app.orderCursor + choices.length - 1) % choices.length;
  else if (e.key === "Enter" || e.key === " ") {
    const c = choices[app.orderCursor];
    if (c && b.move?.choice !== c) act(() => b.chooseMove(c));
    else commit();
  } else if (e.code === "KeyD") commit();
  else if (e.key === "Escape") clear();
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
  else if (/^Digit[1-9]$/.test(e.code)) {
    const n = Number(e.code.slice(5));
    const i = rows.findIndex((r) => r.kind === "weapon" && r.weaponIndex === n);
    if (i >= 0) toggleRow(i);
  } else if (e.code === "KeyA") act(() => b.checkAll(true));
  else if (e.code === "KeyN") act(() => b.checkAll(false));
  else if (e.code === "KeyX") {
    const i = rows.findIndex((r) => r.kind !== "weapon");
    if (i >= 0) app.orderCursor = i;
  } else if (e.code === "KeyD" || e.key === "Enter") commit();
  else if (e.key === "Escape") clear();
  else return false;
  return true;
}
