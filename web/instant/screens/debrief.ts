/**
 * Screen 4: Battle Debrief. A letterhead (verdict, mode, map, side totals)
 * over tabs: result, units, fires, timeline, salvage, log. The tab body
 * scrolls when it is taller than its rows.
 */
import {
  collectAmmoBins,
  destroyedSlots,
  isHull,
  isUnitRemoved,
  type Location,
  loadAmmoBins,
  mechDefFor,
  pilotStatus,
  salvageReport,
  scoreReport,
  type UnitState,
  unitScore,
  usableShots,
} from "btlib10x";
import { type Chronicle, damageByTurn, type Moment, type UnitRecord } from "../battle/chronicle";
import type { BattleController } from "../battle/controller";
import { type BattleResult, unitLoss } from "../battle/victory";
import { battleBanners, battleMapSource, rematch } from "../flow";
import { locName, t } from "../i18n";
import { bracket } from "../input";
import type { Banner } from "../map/view";
import { app, kitModal, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiChild, TuiNode } from "../tui";
import { levelCls } from "./battle.sheet";
import {
  blank,
  cells,
  fit,
  h,
  kit,
  logView,
  mapSlot,
  modal,
  row,
  span,
  statusbar,
  tabBar,
} from "./common";
import { closesMessage } from "./menu";
import { openOptions, optionsKey, optionsWindow } from "./options";
import { pileTipFor } from "./piles";

const { GRID: G, MARK: M, ARROW: A, BAR: B, FRAME: F } = UI_THEME;

const TABS = [
  "debrief.result",
  "debrief.units",
  "debrief.fires",
  "debrief.timeline",
  "debrief.salvage",
  "debrief.map",
  "battle.log",
];
const MAP_TAB = 5;
const LOG_TAB = 6;
/** Content width inside the screen box. */
const W = 96;
/** Rows of the tab body under the letterhead and tab bar. */
const BODY_ROWS = 20;
const LOCS: readonly Location[] = [
  "head",
  "centerTorso",
  "rightTorso",
  "leftTorso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
];

const num = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n));
const pct = (hits: number, shots: number) =>
  shots > 0 ? `${Math.round((100 * hits) / shots)}%` : "—";

/** One row of mixed runs (strings and spans). */
function line(key: string, kids: readonly TuiChild[], cls = ""): TuiNode {
  return h().el("div", { class: `ia-row ${cls}`.trim(), key }, ...kids);
}

/** Display width of a run list built from strings and `run()` spans. */
const TEXT = new WeakMap<object, string>();
function run(text: string, cls?: string): TuiChild {
  if (!cls) return text;
  const n = span(text, { cls });
  TEXT.set(n as object, text);
  return n;
}
function width(kids: readonly TuiChild[]): number {
  return cells(
    kids.map((k) => (typeof k === "string" ? k : (TEXT.get(k as object) ?? ""))).join(""),
  );
}
function centered(key: string, kids: readonly TuiChild[], cls = ""): TuiNode {
  const left = Math.max(0, (W - width(kids)) >> 1);
  return line(key, [" ".repeat(left), ...kids], cls);
}
const dim = (s: string) => run(s, "ia-dim");
const chip = (s: string, cls: string) => run(`${M.chipL}${s}${M.chipR}`, cls);

function units(b: BattleController): UnitState[] {
  return Object.values(b.state.units);
}

/** Unit id coloured by team. */
function uid(b: BattleController, id: string, suffix = ""): TuiChild {
  const u = b.state.units[id];
  return run(`${id}${suffix}`, u ? `ia-team${u.team}` : "");
}

/** Fill a message's `{slots}`; slots naming a unit come out in its team colour. */
function fill(b: BattleController, key: string, vars: Record<string, string | number>): TuiChild[] {
  const out: TuiChild[] = [];
  for (const [i, part] of t(key)
    .split(/\{(\w+)\}/)
    .entries()) {
    if (i % 2 === 0) {
      if (part) out.push(part);
    } else {
      const v = String(vars[part] ?? "");
      out.push(b.state.units[v] ? uid(b, v) : v);
    }
  }
  return out;
}

function modeName(b: BattleController): string {
  return b.mode.kind === "destroyAll"
    ? t("mode.destroyAll")
    : t("mode.damageRaceN", { n: b.mode.turns });
}

/** How a removed unit left play, in a few words. */
function removalText(u: UnitState): string {
  if (u.removed === "destroyed" || !isHull(u)) return t("debrief.status.destroyed");
  return t(`debrief.status.${u.removed}`);
}

function lastOut(b: BattleController, team: number): Extract<Moment, { kind: "removed" }> | null {
  const ms = b.chronicle.moments.filter(
    (m): m is Extract<Moment, { kind: "removed" }> =>
      m.kind === "removed" && b.state.units[m.unitId]?.team === team,
  );
  return ms[ms.length - 1] ?? null;
}

function loserOf(r: BattleResult): number | null {
  if (r.winnerTeam === null) return null;
  return r.sides.find((s) => s.team !== r.winnerTeam)?.team ?? null;
}

/** One-line reason under the verdict. */
function reasonShort(r: BattleResult): string {
  const [a, b] = r.sides;
  const loser = loserOf(r);
  switch (r.decidedBy) {
    case "elimination":
      return loser === null ? t("debrief.why.allOut") : t("debrief.why.elim", { side: loser });
    case "damage": {
      const w = r.sides.find((s) => s.team === r.winnerTeam)!;
      const l = r.sides.find((s) => s.team !== r.winnerTeam)!;
      return t("debrief.why.damage", { side: w.team, a: w.dealt, b: l.dealt });
    }
    case "score":
      return t("debrief.why.score", { n: a?.dealt ?? 0, side: r.winnerTeam ?? "" });
    default:
      return t("debrief.why.tie", { n: a?.dealt ?? 0, s: num(b?.score ?? 0) });
  }
}

// ------------------------------------------------------------ letterhead

function letterhead(b: BattleController, r: BattleResult): TuiNode[] {
  const verdict =
    r.winnerTeam === null
      ? run(t("debrief.drawTitle"), "ia-bright")
      : run(t("debrief.victory", { side: r.winnerTeam }), `ia-team${r.winnerTeam} ia-bright`);
  const rule = dim(F.h.repeat(7));
  // One line per side, the fields in aligned columns: the damage the result
  // counts (whole totals for units out of play), then what the side's hits did.
  const cols = r.sides.map((s) => {
    let hits = 0;
    for (const u of units(b)) if (u.team === s.team) hits += b.chronicle.units[u.id]?.dealt ?? 0;
    return {
      s,
      lost: t("debrief.lostOf", { n: s.lost, of: s.units }),
      dmg: t("debrief.dmg", { n: s.dealt, d: hits }),
      bv: signed(s.score),
    };
  });
  const wide = (k: "lost" | "dmg" | "bv") => Math.max(...cols.map((c) => cells(c[k])));
  const [wl, wd, wb] = [wide("lost"), wide("dmg"), wide("bv")];
  const sideLines = cols.map((c) => [
    run(t("debrief.sideN", { side: c.s.team }), `ia-team${c.s.team} ia-bright`),
    "  ",
    fit(c.lost, wl),
    dim(` ${M.sep} `),
    fit(c.dmg, wd),
    dim(` ${M.sep} BV `),
    run(fit(c.bv, wb, "right"), "ia-bright"),
  ]);
  const pad = " ".repeat(Math.max(0, (W - Math.max(...sideLines.map(width))) >> 1));
  return [
    blank(1)[0]!,
    centered("lh1", [rule, "  ", verdict, "  ", rule]),
    centered("lh2", [
      run(modeName(b), "ia-accent"),
      dim(` ${M.sep} `),
      b.mapName,
      dim(` ${M.sep} `),
      t("debrief.ended", { turn: r.turn }),
    ]),
    centered("lh3", [dim(reasonShort(r))]),
    ...sideLines.map((kids, i) => line(`lh${4 + i}`, [pad, ...kids])),
    row(G.th.repeat(W), { cls: "ia-dim", key: "lh6" }),
  ];
}

// ------------------------------------------------------------ result

/** The unit the debrief singles out: most kills, then damage, then hit rate. */
export function mvp(c: Chronicle, all: readonly UnitState[], team: number | null): string | null {
  let best: [string, UnitRecord] | null = null;
  for (const u of all) {
    if (team !== null && u.team !== team) continue;
    const rec = c.units[u.id];
    if (!rec || rec.dealt <= 0) continue;
    if (
      !best ||
      rec.kills.length > best[1].kills.length ||
      (rec.kills.length === best[1].kills.length &&
        (rec.dealt > best[1].dealt ||
          (rec.dealt === best[1].dealt && rec.hits * best[1].shots > best[1].hits * rec.shots)))
    )
      best = [u.id, rec];
  }
  return best?.[0] ?? null;
}

function resultTab(b: BattleController, r: BattleResult): TuiNode[] {
  const out: TuiNode[] = [blank(1)[0]!];
  const head =
    r.winnerTeam === null ? t("debrief.whyDraw") : t("debrief.whyWon", { side: r.winnerTeam });
  out.push(row(`  ${head}`, { cls: "ia-accent", key: "w0" }));
  const loser = loserOf(r);
  if (r.decidedBy === "elimination") {
    const team = loser ?? r.sides[r.sides.length - 1]?.team ?? 2;
    out.push(row(`   ${t("debrief.why.elimLong", { side: team })}`, { key: "w1" }));
    const m = lastOut(b, team);
    const u = m ? b.state.units[m.unitId] : undefined;
    if (m && u)
      out.push(
        line("w2", [
          "   ",
          ...fill(b, "debrief.why.lastOut", {
            id: u.id,
            model: u.model,
            how: removalText(u),
            turn: m.turn,
          }),
        ]),
      );
  } else {
    const [a, c] = r.sides;
    const vars = {
      n: b.mode.kind === "damageRace" ? b.mode.turns : r.turn,
      a: a?.dealt ?? 0,
      b: c?.dealt ?? 0,
      sa: signed(a?.score ?? 0),
      sb: signed(c?.score ?? 0),
    };
    out.push(row(`   ${t(`debrief.why.${r.decidedBy}Long`, vars)}`, { key: "w1" }));
  }
  const best = mvp(b.chronicle, units(b), r.winnerTeam);
  if (best) {
    const u = b.state.units[best]!;
    const rec = b.chronicle.units[best]!;
    const def = mechDefFor(u);
    out.push(
      row(" ", { key: "mb" }),
      line("mvp", [
        "  ",
        run(t("debrief.mvp"), "ia-accent"),
        "  ",
        chip(`${u.id} ${def.model} ${def.name}`, `ia-team${u.team}`),
        "  ",
        t("debrief.mvpLine", {
          k: rec.kills.length,
          d: rec.dealt,
          p: pct(rec.hits, rec.shots),
        }),
      ]),
    );
  }
  out.push(
    row(" ", { key: "bb" }),
    // the longer title leaves no room for the rule beside it
    line("bv0", ["  ", run(t("debrief.bvTitle"), "ia-accent")]),
    line("bv0r", ["  ", dim(t("debrief.bvRule"))]),
  );
  const report = scoreReport(b.state);
  const term = (u: { unitId: string; value: number; lost: number }) =>
    `${u.unitId} ${num(u.value)}×${u.lost.toFixed(2)}`;
  for (const ts of report) {
    const enemy = report.filter((x) => x.team !== ts.team).flatMap((x) => x.units);
    const enemyLost = enemy.reduce((n, u) => n + u.value * u.lost, 0);
    out.push(
      line(`bvA${ts.team}`, [
        "   ",
        run(`S${ts.team}`, `ia-team${ts.team}`),
        ` = 2 × (${enemy.map(term).join(" + ")})`,
      ]),
      line(`bvB${ts.team}`, [`        − (${ts.units.map(term).join(" + ")})`]),
      line(`bvC${ts.team}`, [
        fit(`        = 2 × ${num(enemyLost)} − ${num(ts.lostValue)}`, 72),
        run(`= ${signed(ts.score)}`, "ia-bright"),
      ]),
    );
  }
  out.push(
    row(`   ${t("debrief.bvNote")}`, { cls: "ia-dim", key: "bvn" }),
    row(" ", { key: "nb" }),
    row(`  ${t("debrief.note")}`, { cls: "ia-dim", key: "note" }),
  );
  return out;
}

// ------------------------------------------------------------ units

/** A light rule `cols` wide with labels set into it at their columns. */
function ruleAt(cols: number, labels: readonly [number, string][]): string {
  let out = "";
  for (const [col, label] of labels) {
    out += `${G.th.repeat(Math.max(1, col - 1 - cells(out)))} ${label} `;
  }
  return out + G.th.repeat(Math.max(0, cols - cells(out)));
}

function pipBar(cur: number, max: number, n = 8): TuiChild[] {
  const f = max > 0 ? Math.round((n * Math.max(0, cur)) / max) : 0;
  return [run(B.pipLeft.repeat(f), levelCls(cur, max)), dim(B.pipTaken.repeat(n - f))];
}

function meter(cur: number, max: number | undefined): TuiChild[] {
  if (max === undefined || max <= 0) return [" ".repeat(14)];
  const c = Math.max(0, cur);
  return [
    run(fit(`${c}/${max}`, 5, "right"), c > 0 ? levelCls(c, max) : "ia-dim"),
    " ",
    ...pipBar(c, max),
  ];
}

/** Destroyed slots of one location, merged by name (`Heat Sink ×2`). */
function critNames(u: UnitState, loc: Location): string[] {
  const def = mechDefFor(u);
  const layout = def.critSlots[loc];
  const counts = new Map<string, number>();
  for (const i of destroyedSlots(u.critSlotsDestroyed, loc)) {
    const s = layout[i];
    if (!s || s.kind === "empty" || s.kind === "soak") continue;
    const name =
      s.kind === "weapon"
        ? s.weapon
        : s.kind === "ammo"
          ? t("debrief.ammoOf", { weapon: s.weapon })
          : (s.name ?? t(`crit.${s.type}`));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([n, k]) => (k > 1 ? `${n} ${M.times}${k}` : n));
}

function statusChip(u: UnitState): TuiChild | null {
  if (!isUnitRemoved(u)) return null;
  return chip(removalText(u).toUpperCase(), isHull(u) ? "ia-lv-orange" : "ia-lv-red");
}

function killTurn(b: BattleController, id: string): number | null {
  const m = b.chronicle.moments.find((x) => x.kind === "removed" && x.unitId === id);
  return m?.turn ?? null;
}

function unitList(all: readonly UnitState[]): TuiNode {
  const H = h();
  const rows: TuiNode[] = [];
  all.forEach((u, i) => {
    if (i > 0 && u.team !== all[i - 1]!.team) rows.push(row(" ", { key: `gap${i}` }));
    const sel = i === app.debriefUnit;
    const st = statusChip(u);
    rows.push(
      H.el(
        "div",
        {
          class: `ia-row${sel ? " ia-bright" : ""}`,
          key: `u${u.id}`,
          attrs: { "data-click": "" },
          onClick: () => {
            app.debriefUnit = i;
          },
        },
        run(`${sel ? A.cursor : " "}${fit(u.id, 3)} ${fit(u.model, 9)} `, `ia-team${u.team}`),
        st ?? "",
      ),
    );
  });
  return H.box(
    { key: "ulist", cols: 29, rows: "auto", pad: 0, title: t("debrief.units") },
    ...rows,
  );
}

function unitCard(b: BattleController, u: UnitState): TuiNode {
  const def = mechDefFor(u);
  const rec = b.chronicle.units[u.id];
  const score = unitScore(u);
  const control = b.control[u.id] ? t("debrief.ai") : t("debrief.player");
  const ps = pilotStatus(u);
  const pilot =
    ps === "active" || ps === "unconscious"
      ? u.pilotHits > 0
        ? chip(t("debrief.pilotHits", { n: u.pilotHits }), "ia-lv-yellow")
        : chip(t("debrief.pilotOk"), "ia-lv-green")
      : chip(t(`chip.pilot.${ps}`), ps === "dead" ? "ia-lv-red" : "ia-dim");
  const st = statusChip(u);
  const out: TuiNode[] = [
    line("c0", [
      " ",
      ...(st ? [st, " "] : []),
      pilot,
      ` G${u.gunnery}/P${u.piloting} ${M.sep} BV ${num(score.value)} ${M.sep} `,
      t("debrief.lostPct", { n: Math.round(score.lost * 100) }),
    ]),
  ];
  const kills = (rec?.kills ?? []).flatMap((id, i) => {
    const turn = killTurn(b, id);
    return [
      ...(i ? [dim(` ${M.sep} `)] : []),
      uid(b, id),
      ` ${b.state.units[id]?.model ?? ""}${turn ? ` (t${turn})` : ""}`,
    ];
  });
  const assists = (rec?.assists ?? []).flatMap((id, i) => [...(i ? [", "] : []), uid(b, id)]);
  out.push(
    line("c1", [
      dim(` ${fit(t("debrief.kills"), 8)}`),
      ...(kills.length ? kills : [dim("—")]),
      ...(assists.length ? [dim(`   ${t("debrief.assists")} `), ...assists] : []),
    ]),
    line("c2", [
      dim(` ${fit(t("debrief.damage"), 8)}`),
      t("debrief.dealtTaken", { d: rec?.dealt ?? 0, t: unitLoss(u, b.totals) }),
      dim(`   ${t("debrief.peakHeat")} `),
      run(
        String(rec?.peakHeat ?? 0),
        (rec?.peakHeat ?? 0) >= 14 ? "ia-lv-red" : (rec?.peakHeat ?? 0) >= 8 ? "ia-lv-yellow" : "",
      ),
      ` ${M.sep} `,
      (rec?.shutdowns ?? 0) > 0
        ? t("debrief.shutdowns", { n: rec!.shutdowns })
        : t("debrief.noShutdown"),
    ]),
    row(
      ruleAt(63, [
        [2, t("debrief.loc")],
        [8, t("debrief.is")],
        [24, t("debrief.armor")],
        [40, t("debrief.rear")],
      ]),
      {
        cls: "ia-dim",
        key: "c3",
      },
    ),
  );
  for (const loc of LOCS) {
    const rear = (u.damage.armorRear as Partial<Record<Location, number>>)[loc];
    const rearMax = (def.armorRear as Partial<Record<Location, number>>)[loc];
    out.push(
      line(`loc${loc}`, [
        `  ${fit(locName(loc), 4)}`,
        ...meter(u.damage.internalStructure[loc], def.internalStructure[loc]),
        "  ",
        ...meter(u.damage.armor[loc], def.armor[loc]),
        "  ",
        ...(rear === undefined ? [] : meter(rear, rearMax)),
      ]),
    );
  }
  out.push(row(ruleAt(63, [[2, t("debrief.crits")]]), { cls: "ia-dim", key: "c4" }));
  let any = false;
  for (const loc of LOCS) {
    const names = critNames(u, loc);
    if (names.length === 0) continue;
    any = true;
    out.push(
      row(fit(`  ${fit(locName(loc), 4)}${names.join(` ${M.sep} `)}`, 63), { key: `cr${loc}` }),
    );
  }
  if (!any) out.push(row(`  ${t("debrief.noCrits")}`, { cls: "ia-dim", key: "crn" }));
  return h().box(
    {
      key: "ucard",
      cols: 65,
      rows: "auto",
      pad: 0,
      class: `ia-side${u.team}`,
      title: `${u.id} ${def.model} ${def.name} ${M.sep} ${t("debrief.sideN", { side: u.team })} ${M.sep} ${control}`,
    },
    ...out,
  );
}

function unitsTab(b: BattleController): TuiNode[] {
  const all = units(b);
  const u = all[Math.min(app.debriefUnit, all.length - 1)];
  if (!u) return [];
  return [
    h().el(
      "div",
      {
        key: "ugrid",
        style: {
          display: "grid",
          "grid-template-columns": "calc(29 * var(--cw)) var(--cw) calc(65 * var(--cw))",
          "align-items": "start",
          "padding-left": "var(--cw)",
        },
      },
      unitList(all),
      h().el("div", {}),
      unitCard(b, u),
    ),
  ];
}

// ------------------------------------------------------------ fires

/** Shots spent per weapon name: `[weapon, spent, loaded]`, spent first. */
export function ammoSpent(u: UnitState): [string, number, number][] {
  const def = mechDefFor(u);
  const loaded = loadAmmoBins(def);
  const by = new Map<string, [number, number]>();
  for (const bin of collectAmmoBins(def)) {
    const full = loaded[bin.id] ?? 0;
    const left = Math.max(0, u.ammoBins[bin.id] ?? 0);
    const e = by.get(bin.weapon) ?? [0, 0];
    e[0] += Math.max(0, full - left);
    e[1] += full;
    by.set(bin.weapon, e);
  }
  return [...by].filter(([, [s]]) => s > 0).map(([w, [s, f]]) => [w, s, f]);
}

function firesTab(b: BattleController): TuiNode[] {
  const all = units(b);
  const head =
    `  ${fit(t("debrief.id"), 4)}${fit(t("debrief.mech"), 9)}${fit(t("debrief.shots"), 7, "right")}` +
    `${fit(t("debrief.hits"), 6, "right")}${fit(t("debrief.hitPct"), 6, "right")}${fit(t("debrief.dealtCol"), 7, "right")}` +
    `${fit(t("debrief.takenCol"), 7, "right")}${fit(t("debrief.kills"), 7, "right")}${fit(t("debrief.peakHeat"), 11, "right")}  ${t("debrief.ammo")}`;
  const out: TuiNode[] = [
    row(fit(head, W), { cls: "ia-dim", key: "h" }),
    row(`  ${G.th.repeat(W - 2)}`, { cls: "ia-dim", key: "hs" }),
  ];
  all.forEach((u, i) => {
    const rec = b.chronicle.units[u.id]!;
    const sel = i === app.debriefUnit;
    const ammo = ammoSpent(u)
      .map(([w, s, f]) => `${w} ${s}/${f}`)
      .join(` ${M.sep} `);
    const heatCls = rec.peakHeat >= 14 ? "ia-lv-red" : rec.peakHeat >= 8 ? "ia-lv-yellow" : "";
    out.push(
      h().el(
        "div",
        {
          class: "ia-row",
          key: `f${u.id}`,
          attrs: { "data-click": "" },
          onClick: () => {
            app.debriefUnit = i;
          },
        },
        run(
          `${sel ? ` ${A.cursor}` : "  "}${fit(u.id, 4)}${fit(u.model, 9)}${fit(rec.shots, 7, "right")}` +
            `${fit(rec.hits, 6, "right")}${fit(pct(rec.hits, rec.shots), 6, "right")}${fit(rec.dealt, 7, "right")}` +
            `${fit(unitLoss(u, b.totals), 7, "right")}${fit(rec.kills.length, 7, "right")}`,
          `ia-team${u.team}${sel ? " ia-bright" : ""}`,
        ),
        run(fit(rec.peakHeat, 11, "right"), heatCls),
        "  ",
        dim(fit(ammo || "—", 28)),
      ),
    );
  });
  const u = all[Math.min(app.debriefUnit, all.length - 1)];
  if (!u) return out;
  const rec = b.chronicle.units[u.id]!;
  out.push(
    row(" ", { key: "wb" }),
    line("wh", [
      "  ",
      run(t("debrief.weaponsOf"), "ia-accent"),
      " ",
      uid(b, u.id),
      run(` ${u.model}`, `ia-team${u.team}`),
      dim(
        " ".repeat(Math.max(1, 31 - cells(t("debrief.weaponsOf")) - u.id.length - u.model.length)) +
          `${fit(t("debrief.shots"), 7, "right")}${fit(t("debrief.hits"), 6, "right")}${fit(t("debrief.hitPct"), 6, "right")}${fit(t("debrief.damage"), 8, "right")}  ${t("debrief.best")}`,
      ),
    ]),
    row(`  ${G.th.repeat(W - 2)}`, { cls: "ia-dim", key: "ws" }),
  );
  const weapons = [...rec.weapons].sort((a, c) => c.damage - a.damage || c.shots - a.shots);
  if (weapons.length === 0)
    out.push(row(`   ${t("debrief.noFire")}`, { cls: "ia-dim", key: "wn" }));
  weapons.forEach((w, i) => {
    const name = w.physical ? t(`phys.${w.name}`) : w.name;
    out.push(
      line(`w${i}`, [
        `   ${fit(name, 32)}${fit(w.shots, 7, "right")}${fit(w.hits, 6, "right")}${fit(pct(w.hits, w.shots), 6, "right")}${fit(w.damage, 8, "right")}  `,
        ...(w.best
          ? [dim(`t${w.best.turn} ${A.to} `), uid(b, w.best.targetId), dim(`, ${w.best.damage}`)]
          : []),
      ]),
    );
  });
  out.push(
    row(" ", { key: "nb" }),
    row(`  ${t("debrief.fireNote")}`, { cls: "ia-dim", key: "note" }),
  );
  return out;
}

// ------------------------------------------------------------ timeline

function momentKids(b: BattleController, m: Moment): { kids: TuiChild[]; cls: string } {
  const model = (id: string) => b.state.units[id]?.model ?? "";
  switch (m.kind) {
    case "firstBlood":
      return {
        kids: fill(b, "debrief.m.firstBlood", { a: m.unitId, b: m.targetId, n: m.damage }),
        cls: "",
      };
    case "fell":
      return { kids: fill(b, "debrief.m.fell", { id: m.unitId }), cls: "" };
    case "shutdown":
      return {
        kids: fill(b, "debrief.m.shutdown", { id: m.unitId, heat: m.heat }),
        cls: "ia-lv-yellow",
      };
    case "ammoBoom":
      return {
        kids: fill(b, "debrief.m.ammoBoom", { id: m.unitId, weapon: m.weapon }),
        cls: "ia-lv-red",
      };
    case "unconscious":
      return { kids: fill(b, "debrief.m.unconscious", { id: m.unitId }), cls: "ia-lv-orange" };
    case "removed": {
      const key =
        m.reason === "destroyed"
          ? "destroyed"
          : m.reason === "pilotKilled"
            ? "pilotKilled"
            : m.reason;
      const by = m.by && m.reason !== "pilotEjected" && m.reason !== "pilotAbandoned" ? "By" : "";
      return {
        kids: [
          `${M.out} `,
          ...fill(b, `debrief.m.${key}${by}`, {
            id: m.unitId,
            model: model(m.unitId),
            by: m.by ?? "",
          }),
        ],
        cls: m.reason === "destroyed" || m.reason === "pilotKilled" ? "ia-lv-red" : "ia-lv-orange",
      };
    }
  }
}

function timelineTab(b: BattleController, r: BattleResult): TuiNode[] {
  const turns = Math.max(r.turn, ...Object.values(b.chronicle.perTurn).map((x) => x.length));
  const dmg = damageByTurn(b.chronicle, turns);
  const teams = Object.keys(dmg)
    .map(Number)
    .sort((a, c) => a - c);
  const max = Math.max(1, ...teams.flatMap((tm) => dmg[tm]!));
  const BAR = 27;
  const left: TuiChild[][] = [
    [
      run(fit(t("debrief.perTurn"), 30), "ia-accent"),
      ...teams.flatMap((tm) => [run(`${B.pipLeft} S${tm}`, `ia-team${tm}`), "  "]),
    ],
    [dim(G.th.repeat(44))],
  ];
  for (let i = 0; i < turns; i++) {
    teams.forEach((tm, j) => {
      const v = dmg[tm]![i]!;
      left.push([
        fit(j === 0 ? `T${i + 1}` : "", 4),
        dim(`S${tm} `),
        run(fit(B.pipLeft.repeat(Math.round((BAR * v) / max)), BAR), `ia-team${tm}`),
        fit(v, 4, "right"),
      ]);
    });
  }
  const right: TuiChild[][] = [[run(t("debrief.moments"), "ia-accent")], [dim(G.th.repeat(46))]];
  for (const m of b.chronicle.moments) {
    const { kids, cls } = momentKids(b, m);
    const tagged = kids.map((k) => (typeof k === "string" && cls ? run(k, cls) : k));
    right.push([dim(fit(`T${m.turn}`, 4)), ...tagged]);
  }
  if (b.chronicle.moments.length === 0) right.push([dim(t("debrief.noMoments"))]);
  // Who led on damage, and the turn with the widest gap.
  if (teams.length === 2) {
    const [ta, tb] = teams as [number, number];
    let ca = 0;
    let cb = 0;
    let leader: number | null = null;
    let since = 0;
    let swing = 0;
    let swingGap = 0;
    for (let i = 0; i < turns; i++) {
      const da = dmg[ta]![i]!;
      const db = dmg[tb]![i]!;
      ca += da;
      cb += db;
      const lead = ca === cb ? null : ca > cb ? ta : tb;
      if (lead !== leader) {
        leader = lead;
        since = i + 1;
      }
      if (Math.abs(da - db) > swingGap) {
        swingGap = Math.abs(da - db);
        swing = i + 1;
      }
    }
    right.push([]);
    if (swing > 0)
      right.push([
        dim(`${t("debrief.swing")} `),
        `T${swing}  `,
        ...fill(b, "debrief.swingLine", {
          side: dmg[ta]![swing - 1]! > dmg[tb]![swing - 1]! ? ta : tb,
          n: swingGap,
        }),
      ]);
    if (leader !== null) right.push([dim(t("debrief.led", { side: leader, turn: since }))]);
  }
  const out: TuiNode[] = [];
  for (let k = 0; k < Math.max(left.length, right.length); k++) {
    const l = left[k] ?? [];
    const rr = right[k] ?? [];
    const rw = width(rr);
    out.push(
      line(`t${k}`, [
        "  ",
        ...l,
        " ".repeat(Math.max(0, 44 - width(l))),
        dim(`  ${G.tv} `),
        ...(rw > 46
          ? [
              fit(
                rr.map((x) => (typeof x === "string" ? x : (TEXT.get(x as object) ?? ""))).join(""),
                46,
              ),
            ]
          : rr),
      ]),
    );
  }
  return out;
}

// ------------------------------------------------------------ salvage

function salvageTab(b: BattleController): TuiNode[] {
  const report = salvageReport(b.state);
  if (report.length === 0)
    return [blank(1)[0]!, row(`  ${t("debrief.noSalvage")}`, { cls: "ia-dim", key: "none" })];
  let items = 0;
  const blocks: TuiNode[] = [];
  report.forEach((e, i) => {
    const u = b.state.units[e.unitId]!;
    const def = mechDefFor(u);
    const weapons = new Map<string, { n: number; locs: string[] }>();
    const equipment = new Map<string, number>();
    for (const it of e.salvageable) {
      items += it.count;
      if (it.kind === "weapon") {
        const w = weapons.get(it.name) ?? { n: 0, locs: [] };
        w.n += it.count;
        const loc = locName(it.location) + (it.severed ? "*" : "");
        if (!w.locs.includes(loc)) w.locs.push(loc);
        weapons.set(it.name, w);
      } else {
        const name = t(`crit.${it.name}`);
        equipment.set(name, (equipment.get(name) ?? 0) + it.count);
      }
    }
    const ammo = new Map<string, number>();
    for (const bin of collectAmmoBins(def)) {
      const shots =
        usableShots(u, bin) + (e.strandedAmmo.find((s) => s.binId === bin.id)?.shots ?? 0);
      if (shots > 0) ammo.set(bin.weapon, (ammo.get(bin.weapon) ?? 0) + shots);
    }
    const times = (name: string, n: number) => (n > 1 ? `${name} ${M.times}${n}` : name);
    const kind = e.kind === "hull" ? t(`debrief.hull.${e.reason}`) : t("debrief.kind.wreckage");
    blocks.push(
      line(`h${i}`, [
        "  ",
        run(`${e.unitId} ${def.model} ${def.name}`, `ia-team${e.team} ia-bright`),
        dim(` ${M.sep} ${kind} ${M.sep} (${e.hex.col},${e.hex.row})`),
      ]),
    );
    const part = (key: string, label: string, text: string) => {
      if (!text) return;
      blocks.push(line(`${key}${i}`, ["   ", run(fit(label, 9), "ia-accent"), fit(text, W - 12)]));
    };
    part(
      "w",
      t("debrief.sv.weapons"),
      [...weapons].map(([n, w]) => `${times(n, w.n)} (${w.locs.join(", ")})`).join(` ${M.sep} `),
    );
    part(
      "a",
      t("debrief.sv.ammo"),
      [...ammo].map(([w, s]) => `${w} ${M.times}${s}`).join(` ${M.sep} `),
    );
    part(
      "e",
      t("debrief.sv.systems"),
      [...equipment].map(([n, k]) => times(n, k)).join(` ${M.sep} `),
    );
    blocks.push(row(" ", { key: `g${i}` }));
  });
  return [
    row(`  ${t("debrief.svSummary", { n: report.length, m: items })}`, { key: "sum" }),
    row(" ", { key: "sb" }),
    ...blocks,
    ...(report.some((e) => e.salvageable.some((x) => x.severed))
      ? [row(`  ${t("debrief.severed")}`, { cls: "ia-dim", key: "sev" })]
      : []),
  ];
}

// ------------------------------------------------------------ map

function mapTab(): TuiNode[] {
  const glyph = (g: string, label: string, k: string) => [
    span(g, { cls: "ia-bright", key: `g${k}` }),
    span(` ${t(label)}`, { key: `l${k}` }),
  ];
  const sep = (k: string) => span(` ${M.sep} `, { cls: "ia-dim", key: `s${k}` });
  const legend = h().el(
    "span",
    { key: "legend" },
    ...glyph("■", "debrief.lg.inPlay", "a"),
    sep("a"),
    ...glyph("▣", "debrief.lg.hull", "b"),
    sep("b"),
    ...glyph(M.out, "debrief.lg.wreck", "c"),
    sep("c"),
    ...glyph("%", "debrief.lg.wreckage", "d"),
    sep("d"),
    ...glyph("!", "debrief.lg.limb", "e"),
  );
  const band = h().el(
    "div",
    { class: "ia-maplegend", key: "maplegend" },
    legend,
    span(t("debrief.mapHint"), { cls: "ia-dim", key: "hint" }),
  );
  return [
    h().el(
      "div",
      { class: "ia-mapbox", key: "mapbox", style: { height: `calc(${BODY_ROWS} * var(--ch))` } },
      mapSlot(),
      band,
    ),
  ];
}

/** The debrief board's signs: units in play, team-tinted hulls and the wrecks of destroyed units. */
function debriefBanners(b: BattleController): Banner[] {
  const out: Banner[] = [];
  for (const u of Object.values(b.state.units)) {
    if (!isUnitRemoved(u)) continue;
    const hull = isHull(u);
    if (!hull && u.destroyed === "not") continue;
    out.push({
      id: hull ? `-${u.id}` : `${M.out}${u.id}`,
      hex: u.position,
      facing: u.facing,
      team: u.team,
      sub: hull ? "HULL" : "WRECK",
      ghost: true,
    });
  }
  // Signs sharing a hex stack in list order, so the wrecks and hulls stand above the units in play.
  return [...battleBanners().filter((x) => !x.id.startsWith("-")), ...out];
}

/** Battle the map was last fitted for: the Map tab shows and fits the board once per battle. */
let fittedFor: BattleController | null = null;

/** After a render of the Map tab: the final board, hulls and wreckage, no prompt marks. */
export function debriefOverlays(): void {
  const v = app.mapView;
  const b = app.battle;
  if (!v || !b || app.tab !== MAP_TAB) return;
  v.tipFor = pileTipFor(b.state);
  const piles = (by: Readonly<Record<string, readonly unknown[] | undefined>>) =>
    new Set(Object.keys(by).filter((k) => (by[k]?.length ?? 0) > 0));
  v.overlays = { wreckage: piles(b.state.wreckage), clubs: piles(b.state.clubs) };
  v.banners = debriefBanners(b);
  if (fittedFor !== b) {
    fittedFor = b;
    v.setMap(battleMapSource(b));
    v.fit();
  }
}

// ------------------------------------------------------------ menu

/**
 * Esc menu: the debrief's actions, which have no keys of their own, then
 * Options under a separator (closing it comes back to this menu on its row).
 */
const MENU: readonly { label: string; run: () => void; sepAbove?: boolean }[] = [
  { label: "debriefMenu.rematch", run: () => confirmRematch() },
  { label: "debriefMenu.setup", run: () => confirmSetup() },
  { label: "debriefMenu.toTitle", run: () => (app.screen = "title") },
  { label: "menu.options", run: () => openOptions(app.modal), sepAbove: true },
];

function menuModal(cursor: number): TuiNode {
  const cols = 40;
  return modal(
    { cols, title: t("debriefMenu.title"), footer: t("dialog.footer") },
    ...MENU.flatMap((it, i) => [
      ...(it.sepAbove ? [row(G.th.repeat(cols - 4), { key: `s${it.label}`, cls: "ia-dim" })] : []),
      row(`${i === cursor ? A.cursor : " "} ${fit(t(it.label), cols - 6)}`, {
        sel: i === cursor,
        key: it.label,
        onClick: () => runMenu(i),
      }),
    ]),
  );
}

function runMenu(i: number): void {
  // Options opens over the menu, which stays on its row
  app.modal = MENU[i]?.label === "menu.options" ? { kind: "debriefMenu", cursor: i } : null;
  MENU[i]?.run();
  rerender();
}

/** A Yes / No confirm (No by default) that runs `then` on Yes. */
function confirm(title: string, text: string, then: () => void): void {
  kitModal.open = true;
  void kit()
    .dialog({ title: t(title), text: t(text), buttons: [t("yes"), t("no")], defaultIndex: 1 })
    .then((r) => {
      kitModal.open = false;
      if (r === t("yes")) then();
      rerender();
    });
}

/** Rematch replays the battle from scratch, so it asks first. */
function confirmRematch(): void {
  confirm("debriefMenu.rematch", "rematch.confirm", rematch);
}

/** Editing the setup leaves the debrief for good, so it asks first. */
function confirmSetup(): void {
  confirm("debriefMenu.setup", "setup.confirm", () => {
    app.screen = "setup";
    app.tab = 0;
  });
}

/** Steps the debrief tab by `d` (−1 previous, +1 next), wrapping. */
function stepTab(d: number): void {
  app.tab = (app.tab + d + TABS.length) % TABS.length;
}

// ------------------------------------------------------------ screen

export function debriefScreen(): TuiNode {
  const H = h();
  const b = app.battle!;
  const r = b.result!;
  let body: TuiNode[];
  if (app.tab === 0) body = resultTab(b, r);
  else if (app.tab === 1) body = unitsTab(b);
  else if (app.tab === 2) body = firesTab(b);
  else if (app.tab === 3) body = timelineTab(b, r);
  else if (app.tab === 4) body = salvageTab(b);
  else if (app.tab === MAP_TAB) body = mapTab();
  else body = [logView(b.log, BODY_ROWS, 94)];
  const m = app.modal;
  return H.el(
    "div",
    { class: "ia-root" },
    H.box(
      { cols: 100, rows: 31, border: "double", title: t("debrief.title") },
      ...letterhead(b, r),
      tabBar(
        TABS.map((k) => t(k)),
        app.tab,
        (i) => {
          app.tab = i;
        },
        true,
      ),
      row(G.th.repeat(W), { cls: "ia-dim", key: "tsep" }),
      app.tab === MAP_TAB || app.tab === LOG_TAB
        ? H.el("div", { key: `body${app.tab}` }, ...body)
        : H.el(
            "div",
            {
              class: "ia-log ia-scroll ia-debrief-body",
              key: `body${app.tab}`,
              style: { height: `calc(${BODY_ROWS} * var(--ch))` },
            },
            ...body,
          ),
    ),
    statusbar([
      ["[ ]", "key.tab"],
      ["↑↓", "key.pickUnit"],
      ["Esc", "key.menu", () => (app.modal = { kind: "debriefMenu", cursor: 0 })],
    ]),
    m?.kind === "debriefMenu" ? menuModal(m.cursor) : null,
    m?.kind === "options" ? optionsWindow(m) : null,
  );
}

export function debriefKey(e: KeyboardEvent): boolean {
  const m = app.modal;
  if (m?.kind === "debriefMenu") {
    if (e.key === "ArrowDown") m.cursor = (m.cursor + 1) % MENU.length;
    else if (e.key === "ArrowUp") m.cursor = (m.cursor + MENU.length - 1) % MENU.length;
    else if (e.key === "Enter" || e.key === " ") runMenu(m.cursor);
    else if (e.key === "Escape" || e.key === "Backspace") app.modal = null;
    else return false;
    return true;
  }
  if (m?.kind === "options") return optionsKey(e, m);
  if (m) {
    if (!closesMessage(e)) return false;
    app.modal = null;
    return true;
  }
  const n = Object.keys(app.battle?.state.units ?? {}).length;
  const page = e.key === "PageDown" ? 1 : e.key === "PageUp" ? -1 : 0;
  const body = page ? document.querySelector<HTMLElement>("#app .ia-debrief-body") : null;
  if (bracket(e)) stepTab(bracket(e));
  else if (e.key === "ArrowDown" && n > 0) app.debriefUnit = (app.debriefUnit + 1) % n;
  else if (e.key === "ArrowUp" && n > 0) app.debriefUnit = (app.debriefUnit + n - 1) % n;
  else if (body) body.scrollTop += page * body.clientHeight * 0.8;
  else if (e.key === "Escape") app.modal = { kind: "debriefMenu", cursor: 0 };
  else return false;
  return true;
}
