/** Screen 1: setup (Side 1, Side 2, Map, Rules) and its modals. */
import { catalogMaps, ensureMapRegistered, weaponDefFor } from "btlib10x";
import { PERSONA_KEYS, PERSONAS, type PersonaKey } from "../ai/persona.data";
import { launch, mapNames, mapSource } from "../flow";
import { type LocaleId, locale, locName, setLocale, t } from "../i18n";
import { createRng } from "../rng";
import {
  defaultFilter,
  filterMechs,
  generateSide,
  MAX_SLOTS,
  mechDef,
  newSlot,
  type Slot,
  sideBv,
  slotId,
  type WeightClass,
} from "../setup/loadout";
import { type AiPace, app, type Modal } from "../state";
import type { TuiNode } from "../tui";
import { blank, fit, h, mapSlot, modal, row, statusbar } from "./common";

const TABS = ["setup.side1", "setup.side2", "setup.map", "setup.rules"];
const AMMO = ["exposed", "core", "spread", "leastFirst"] as const;
const AMS = ["expected", "firstHit", "priority", "off"] as const;
const PACES: AiPace[] = ["instant", "step", "timed"];
const THEMES = ["green", "amber", "paper"] as const;
const ERAS = [3025, 3050, 3075, 3150];
const CLASSES: WeightClass[] = ["light", "medium", "heavy", "assault"];

function controlName(p: PersonaKey | null): string {
  return p === null ? t("ctl.player") : PERSONAS[p].name;
}

const resolved = mechDef;

// ------------------------------------------------------------ screen

export function setupScreen(): TuiNode {
  const H = h();
  const tabs = TABS.map((k, i) => (i === app.tab ? `[ ${t(k)} ]` : `  ${t(k)}  `)).join(" ");
  let body: TuiNode[];
  if (app.tab < 2) body = sideBody(app.tab as 0 | 1);
  else if (app.tab === 2) body = mapBody();
  else body = rulesBody();
  const l = app.loadout;
  const bvA = sideBv(l.sides[0]);
  const bvB = sideBv(l.sides[1]);
  const bal = bvA > 0 ? (((bvB - bvA) / bvA) * 100).toFixed(1) : "-";
  const summary = [
    row(fit(`${t("setup.side1")} ${l.sides[0].length}`, 14) + fit(`BV ${bvA}`, 13, "right"), {
      cls: "ia-team1",
      key: "s1",
    }),
    row(fit(`${t("setup.side2")} ${l.sides[1].length}`, 14) + fit(`BV ${bvB}`, 13, "right"), {
      cls: "ia-team2",
      key: "s2",
    }),
    row(fit(t("setup.balance"), 14) + fit(`${bal} %`, 13, "right"), { key: "bal" }),
    ...blank(1),
    row(fit(`${t("setup.map")}  ${l.map}`, 27), { key: "map" }),
    row(fit(`${t("rules.mode")}  ${modeLabel()}`, 27), { key: "mode" }),
    row(fit(`${t("rules.seed")}  ${l.seed}`, 27), { key: "seed" }),
    row(fit(`AI  ${t(`pace.${app.aiPace}`)}`, 27), { key: "ai" }),
    ...blank(1),
    row(fit(t("setup.deployNote"), 27), { cls: "ia-dim", key: "dn1" }),
    row(fit(t("setup.deployNote2"), 27), { cls: "ia-dim", key: "dn2" }),
    ...blank(9),
    H.el(
      "div",
      { style: { display: "flex", "justify-content": "center" } },
      H.btn({ primary: true, onClick: () => doLaunch() }, t("setup.launch")),
    ),
  ];
  return H.el(
    "div",
    { class: "ia-root" },
    H.split(
      { cols: 100, rows: 31, border: "double", sizes: "69 1fr" },
      H.pane(
        t("setup.title"),
        row(tabs, { cls: "ia-bright", key: "tabs" }),
        row("─".repeat(66), { cls: "ia-dim", key: "tabsep" }),
        ...body,
      ),
      H.pane(t("setup.summary"), ...summary),
    ),
    statusbar(
      [
        ["Tab", "key.tab"],
        ["↑↓", "key.select"],
        ["Enter", "key.choose"],
        ["F10", "key.launch"],
        ["Esc", "key.title"],
        ["F1", "key.help"],
      ],
      app.error ? `! ${app.error}` : "",
    ),
    app.modal ? modalNode(app.modal) : null,
  );
}

function modeLabel(): string {
  const m = app.loadout.mode;
  return m.kind === "destroyAll" ? t("mode.destroyAll") : t("mode.damageRaceN", { n: m.turns });
}

function doLaunch(): void {
  try {
    launch();
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
  }
}

function sideBody(side: 0 | 1): TuiNode[] {
  const slots = app.loadout.sides[side];
  const cur = app.cursors.side[side];
  const head = ` #  ID  ${fit("'Mech", 25)}${fit("t", 4, "right")}${fit("BV", 6, "right")}  G/P  ${t("setup.control")}`;
  const rows = slots.map((s, i) => {
    const def = resolved(s.model);
    const text =
      `${i === cur ? "▸" : " "}${i + 1}  ${fit(slotId(side, i), 4)}${fit(`${s.model} ${def.name}`, 25)}` +
      `${fit(def.tonnage, 4, "right")}${fit(def.bv, 6, "right")}  ${s.gunnery}/${s.piloting}  ${fit(controlName(s.persona), 15)}`;
    return row(text, {
      sel: i === cur,
      key: `slot${i}`,
      onClick: () => {
        app.cursors.side[side] = i;
        app.modal = mechModal(side, i);
      },
    });
  });
  if (slots.length < MAX_SLOTS) {
    rows.push(
      row(`${slots.length === cur ? "▸" : " "}+  ${t("setup.addSlot")}`, {
        sel: cur === slots.length,
        cls: "ia-dim",
        key: "add",
        onClick: () => addSlot(side),
      }),
    );
  }
  return [
    row(head, { cls: "ia-dim", key: "head" }),
    ...rows,
    ...blank(Math.max(0, 19 - rows.length)),
    row("─".repeat(66), { cls: "ia-dim", key: "foot0" }),
    row(t("setup.keys1"), { cls: "ia-dim", key: "foot1" }),
    row(t("setup.keys2"), { cls: "ia-dim", key: "foot2" }),
  ];
}

function mapBody(): TuiNode[] {
  const maps = catalogMaps();
  const cur = app.cursors.map;
  const list = maps.map((m, i) =>
    row(
      `${i === cur ? "▸" : " "} ${fit(m.name, 14)}${fit(`${m.width}×${m.height}`, 7)} ${m.name === app.loadout.map ? "●" : " "}`,
      {
        sel: i === cur,
        key: m.name,
        onClick: () => {
          app.cursors.map = i;
          app.loadout.map = m.name;
        },
      },
    ),
  );
  const H = h();
  return [
    H.el(
      "div",
      {
        style: {
          display: "grid",
          "grid-template-columns": "calc(26 * var(--cw)) 1fr",
          height: "calc(26 * var(--ch))",
        },
      },
      H.el("div", {}, ...list),
      mapSlot(),
    ),
  ];
}

interface RuleRow {
  label: string;
  value: string;
  step: (dir: number) => void;
}

function ruleRows(): RuleRow[] {
  const l = app.loadout;
  return [
    {
      label: "rules.mode",
      value: l.mode.kind === "destroyAll" ? t("mode.destroyAll") : t("mode.damageRace"),
      step: () => {
        l.mode =
          l.mode.kind === "destroyAll" ? { kind: "damageRace", turns: 8 } : { kind: "destroyAll" };
      },
    },
    {
      label: "rules.turns",
      value: l.mode.kind === "damageRace" ? String(l.mode.turns) : "-",
      step: (d) => {
        if (l.mode.kind === "damageRace")
          l.mode = { kind: "damageRace", turns: Math.max(3, Math.min(30, l.mode.turns + d)) };
      },
    },
    {
      label: "rules.seed",
      value: String(l.seed),
      step: (d) => {
        l.seed = Math.max(0, l.seed + d);
      },
    },
    {
      label: "rules.pace",
      value: t(`pace.${app.aiPace}`),
      step: (d) => {
        app.aiPace = PACES[(PACES.indexOf(app.aiPace) + d + PACES.length) % PACES.length]!;
      },
    },
    {
      label: "rules.lang",
      value: locale() === "ko" ? "한국어" : "English",
      step: () => setLocale((locale() === "ko" ? "en" : "ko") as LocaleId),
    },
    {
      label: "rules.theme",
      value: app.theme,
      step: (d) => {
        app.theme = THEMES[(THEMES.indexOf(app.theme) + d + THEMES.length) % THEMES.length]!;
        document.documentElement.dataset.theme = app.theme;
      },
    },
    {
      label: "rules.reasoning",
      value: app.aiReasoning ? t("on") : t("off"),
      step: () => {
        app.aiReasoning = !app.aiReasoning;
      },
    },
  ];
}

function rulesBody(): TuiNode[] {
  const cur = app.cursors.rules;
  return [
    ...ruleRows().map((r, i) =>
      row(`${i === cur ? "▸" : " "} ${fit(t(r.label), 22)}◂ ${fit(r.value, 20)} ▸`, {
        sel: i === cur,
        key: r.label,
        onClick: () => {
          app.cursors.rules = i;
          r.step(1);
        },
      }),
    ),
    ...blank(2),
    row(t("rules.hint"), { cls: "ia-dim", key: "hint" }),
    row(t("rules.raceHint"), { cls: "ia-dim", key: "hint2" }),
  ];
}

// ------------------------------------------------------------ keys

function addSlot(side: 0 | 1): void {
  const slots = app.loadout.sides[side];
  if (slots.length >= MAX_SLOTS) return;
  slots.push(newSlot(slots[slots.length - 1]?.model ?? "HBK-4G", side === 1 ? "gladiator" : null));
  app.cursors.side[side] = slots.length - 1;
}

export function setupKey(e: KeyboardEvent): boolean {
  if (app.modal) return modalKey(e, app.modal);
  if (e.key === "Tab") {
    app.tab = (app.tab + (e.shiftKey ? 3 : 1)) % 4;
    return true;
  }
  if (e.key === "F10") {
    doLaunch();
    return true;
  }
  if (e.key === "Escape") {
    app.screen = "title";
    return true;
  }
  if (app.tab < 2) return sideKey(e, app.tab as 0 | 1);
  if (app.tab === 2) {
    const n = catalogMaps().length;
    if (e.key === "ArrowDown") app.cursors.map = (app.cursors.map + 1) % n;
    else if (e.key === "ArrowUp") app.cursors.map = (app.cursors.map + n - 1) % n;
    else if (e.key === "Enter" || e.key === " ") app.loadout.map = mapNames()[app.cursors.map]!;
    else return false;
    return true;
  }
  const rows = ruleRows();
  if (e.key === "ArrowDown") app.cursors.rules = (app.cursors.rules + 1) % rows.length;
  else if (e.key === "ArrowUp")
    app.cursors.rules = (app.cursors.rules + rows.length - 1) % rows.length;
  else if (e.key === "ArrowRight" || e.key === "Enter") rows[app.cursors.rules]!.step(1);
  else if (e.key === "ArrowLeft") rows[app.cursors.rules]!.step(-1);
  else if (e.code === "KeyR" && app.cursors.rules === 2)
    app.loadout.seed = Math.floor(Math.random() * 100000);
  else return false;
  return true;
}

function sideKey(e: KeyboardEvent, side: 0 | 1): boolean {
  const slots = app.loadout.sides[side];
  const n = slots.length < MAX_SLOTS ? slots.length + 1 : slots.length;
  const cur = app.cursors.side[side];
  const slot: Slot | undefined = slots[cur];
  if (e.key === "ArrowDown" && !e.altKey) app.cursors.side[side] = (cur + 1) % n;
  else if (e.key === "ArrowUp" && !e.altKey) app.cursors.side[side] = (cur + n - 1) % n;
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && slot) {
    const to = cur + (e.key === "ArrowUp" ? -1 : 1);
    if (to >= 0 && to < slots.length) {
      [slots[cur], slots[to]] = [slots[to]!, slots[cur]!];
      app.cursors.side[side] = to;
    }
  } else if (e.key === "Enter") {
    if (!slot) addSlot(side);
    else app.modal = mechModal(side, cur);
  } else if (e.key === "Insert" || e.key === "+") addSlot(side);
  else if ((e.key === "Delete" || e.key === "Backspace") && slot && slots.length > 1) {
    slots.splice(cur, 1);
    app.cursors.side[side] = Math.min(cur, slots.length - 1);
  } else if (e.code === "KeyP" && slot) app.modal = { kind: "pilot", side, index: cur, cursor: 0 };
  else if (e.code === "KeyC" && slot) {
    app.modal = {
      kind: "control",
      side,
      index: cur,
      cursor: slot.persona === null ? 0 : PERSONA_KEYS.indexOf(slot.persona) + 1,
    };
  } else if (e.code === "KeyO" && slot) app.modal = { kind: "policy", side, index: cur, cursor: 0 };
  else if (e.code === "KeyG")
    app.modal = {
      kind: "generate",
      side,
      cursor: 0,
      count: Math.max(1, slots.length),
      match: 0,
      personas: side === 1 ? 0 : 1,
    };
  else return false;
  return true;
}

// ------------------------------------------------------------ modals

function mechModal(side: 0 | 1, index: number): Modal {
  const f = defaultFilter();
  const list = filterMechs(f);
  const model = app.loadout.sides[side][index]?.model;
  return {
    kind: "mech",
    side,
    index,
    filter: f,
    cursor: Math.max(
      0,
      list.findIndex((m) => m.model === model),
    ),
    field: -1,
  };
}

function modalNode(m: Modal): TuiNode | null {
  switch (m.kind) {
    case "mech":
      return mechBrowser(m);
    case "pilot":
      return pilotDialog(m);
    case "control":
      return controlDialog(m);
    case "policy":
      return policyDialog(m);
    case "generate":
      return generateDialog(m);
    case "help":
      return helpWindow();
    case "message":
      return modal(
        { cols: 60, title: m.title },
        row(m.text),
        ...blank(1),
        row(t("key.anyKey"), { cls: "ia-dim" }),
      );
    default:
      return null;
  }
}

function mechBrowser(m: Extract<Modal, { kind: "mech" }>): TuiNode {
  const H = h();
  const list = filterMechs(m.filter);
  const page = 20;
  const start = Math.max(0, Math.min(m.cursor - 8, list.length - page));
  const f = m.filter;
  const classes = CLASSES.map(
    (c, i) => `${f.classes.includes(c) ? "[x]" : "[ ]"}${i + 1}${t(`class.${c}`)}`,
  ).join(" ");
  const filterLine1 = `/ ${fit(f.text || t("mech.search"), 16)}  ${classes}`;
  const filterLine2 = `T ${t("mech.tech")}:${fit(t(`tech.${f.tech}`), 6)}  K ${t("mech.pack")}:${fit(f.pack, 5)}  E ${t("mech.era")}:≤${f.introMax}  S ${t("mech.sort")}:${fit(t(`sort.${f.sort}`), 7)}  ${list.length}/${filterMechs(defaultFilter()).length}`;
  const rows = list.slice(start, start + page).map((e, k) => {
    const i = start + k;
    return row(
      `${i === m.cursor ? "▸" : " "}${fit(e.model, 13)}${fit(e.name, 16)}${fit(e.tonnage, 4, "right")}${fit(e.bv, 6, "right")}${fit(e.intro, 6, "right")} ${e.pack === "sw" ? "s" : "b"}`,
      {
        sel: i === m.cursor,
        key: e.model,
        onClick: () => {
          if (m.cursor === i) chooseMech(m, e.model);
          else m.cursor = i;
        },
      },
    );
  });
  const sel = list[m.cursor];
  const card: TuiNode[] = [];
  if (sel) {
    const def = resolved(sel.model);
    card.push(
      row(fit(`${def.model}  ${def.name}  ${def.tonnage} t  ${def.techBase}  ${def.intro}`, 44), {
        cls: "ia-bright",
        key: "c0",
      }),
      row(
        fit(
          `${t("mech.walk")} ${def.walking}  ${t("mech.run")} ${def.running}  ${t("mech.jump")} ${def.jumping}    BV ${def.bv}`,
          44,
        ),
        { key: "c1" },
      ),
      row("─".repeat(44), { cls: "ia-dim", key: "c2" }),
      row(
        ` #  ${fit(t("mech.weapon"), 18)}${fit(t("mech.loc"), 4)}${fit(t("mech.heat"), 4, "right")}${fit(t("mech.dmg"), 5, "right")} ${t("mech.range")}`,
        { cls: "ia-dim", key: "c3" },
      ),
      ...Object.values(def.weapons)
        .slice(0, 13)
        .map((w, i) => {
          const wd = weaponDefFor(w);
          const dmg = wd.damage ?? (wd.missiles ? `${wd.missiles}×${wd.missileDamage ?? 1}` : "-");
          return row(
            `${fit(i + 1, 2, "right")}  ${fit(w.weapon + (w.rearFacing ? " (R)" : ""), 18)}${fit(locName(w.location), 4)}${fit(wd.heat ?? 0, 4, "right")}${fit(dmg, 5, "right")} ${wd.short}/${wd.medium}/${wd.long}`,
            { key: `w${i}` },
          );
        }),
    );
    const armor =
      Object.values(def.armor).reduce((a, b) => a + (b ?? 0), 0) +
      Object.values(def.armorRear).reduce((a, b) => a + (b ?? 0), 0);
    card.push(row(" ", { key: "c9" }), row(fit(`${t("mech.armor")} ${armor}`, 44), { key: "ca" }));
  }
  return modal(
    {
      cols: 96,
      rows: 27,
      title: t("mech.title", { id: slotId(m.side, m.index) }),
      footer: t("mech.footer"),
    },
    row(filterLine1, { key: "f1" }),
    row(filterLine2, { key: "f2" }),
    H.el(
      "div",
      {
        style: {
          display: "grid",
          "grid-template-columns": "calc(48 * var(--cw)) 1fr",
          "column-gap": "calc(1 * var(--cw))",
        },
      },
      H.el("div", {}, ...rows),
      H.el("div", {}, ...card),
    ),
  );
}

function chooseMech(m: Extract<Modal, { kind: "mech" }>, model: string): void {
  const slots = app.loadout.sides[m.side];
  const slot = slots[m.index];
  if (slot) slot.model = model;
  else slots.push(newSlot(model, m.side === 1 ? "gladiator" : null));
  app.modal = null;
}

function pilotDialog(m: Extract<Modal, { kind: "pilot" }>): TuiNode {
  const s = app.loadout.sides[m.side][m.index]!;
  const items: [string, number][] = [
    ["pilot.gunnery", s.gunnery],
    ["pilot.piloting", s.piloting],
    ["pilot.hitMax", s.pilotHitMax],
  ];
  return modal(
    {
      cols: 44,
      title: t("pilot.title", { id: slotId(m.side, m.index) }),
      footer: t("dialog.footer"),
    },
    ...items.map(([k, v], i) =>
      row(`${i === m.cursor ? "▸" : " "} ${fit(t(k), 22)}◂ ${fit(v, 3, "right")} ▸`, {
        sel: i === m.cursor,
        key: k,
      }),
    ),
    ...blank(1),
    row(t("pilot.presets"), { cls: "ia-dim", key: "pre" }),
  );
}

function controlDialog(m: Extract<Modal, { kind: "control" }>): TuiNode {
  const opts: (PersonaKey | null)[] = [null, ...PERSONA_KEYS];
  return modal(
    {
      cols: 44,
      title: t("control.title", { id: slotId(m.side, m.index) }),
      footer: t("dialog.footer"),
    },
    ...opts.map((p, i) =>
      row(`${i === m.cursor ? "▸" : " "} ${controlName(p)}`, {
        sel: i === m.cursor,
        key: String(p),
      }),
    ),
  );
}

function policyItems(s: Slot): [string, string, (d: number) => void][] {
  const cyc = <T>(list: readonly T[], v: T, d: number): T =>
    list[(list.indexOf(v) + d + list.length) % list.length]!;
  return [
    [
      "policy.ammo",
      t(`ammo.${s.policy.ammoPolicy}`),
      (d) => (s.policy.ammoPolicy = cyc(AMMO, s.policy.ammoPolicy, d)),
    ],
    [
      "policy.autoEject",
      s.policy.autoEject ? t("on") : t("off"),
      () => (s.policy.autoEject = !s.policy.autoEject),
    ],
    [
      "policy.heatFlamer",
      s.policy.heatFlamer ? t("on") : t("off"),
      () => (s.policy.heatFlamer = !s.policy.heatFlamer),
    ],
    [
      "policy.ams",
      t(`ams.${s.policy.amsPolicy}`),
      (d) => (s.policy.amsPolicy = cyc(AMS, s.policy.amsPolicy, d)),
    ],
  ];
}

function policyDialog(m: Extract<Modal, { kind: "policy" }>): TuiNode {
  const s = app.loadout.sides[m.side][m.index]!;
  return modal(
    {
      cols: 50,
      title: t("policy.title", { id: slotId(m.side, m.index) }),
      footer: t("dialog.footer"),
    },
    ...policyItems(s).map(([k, v], i) =>
      row(`${i === m.cursor ? "▸" : " "} ${fit(t(k), 24)}◂ ${fit(v, 12)} ▸`, {
        sel: i === m.cursor,
        key: k,
      }),
    ),
  );
}

const MATCH = ["gen.matchBv", "gen.matchFree"];
const PERSONA_MODES = ["gen.personaRandom", "gen.personaNone"];

function generateDialog(m: Extract<Modal, { kind: "generate" }>): TuiNode {
  const items: [string, string][] = [
    ["gen.count", String(m.count)],
    ["gen.match", t(MATCH[m.match]!)],
    ["gen.personas", t(PERSONA_MODES[m.personas]!)],
  ];
  return modal(
    { cols: 52, title: t("gen.title", { side: m.side + 1 }), footer: t("gen.footer") },
    ...items.map(([k, v], i) =>
      row(`${i === m.cursor ? "▸" : " "} ${fit(t(k), 18)}◂ ${fit(v, 24)} ▸`, {
        sel: i === m.cursor,
        key: k,
      }),
    ),
  );
}

export function helpWindow(): TuiNode {
  const lines = t("help.text").split("\n");
  return modal(
    { cols: 80, title: t("help.title"), footer: t("key.anyKey") },
    ...lines.map((l, i) => row(l, { key: `h${i}` })),
  );
}

/** Keys while a setup modal is open. */
function modalKey(e: KeyboardEvent, m: Modal): boolean {
  const close = () => {
    app.modal = null;
  };
  if (m.kind === "help" || m.kind === "message") {
    close();
    return true;
  }
  if (m.kind === "mech") return mechKey(e, m);
  const vertical = (n: number) => {
    const c = m as { cursor: number };
    if (e.key === "ArrowDown") c.cursor = (c.cursor + 1) % n;
    else if (e.key === "ArrowUp") c.cursor = (c.cursor + n - 1) % n;
    else return false;
    return true;
  };
  if (e.key === "Escape") {
    close();
    return true;
  }
  if (m.kind === "control") {
    if (vertical(PERSONA_KEYS.length + 1)) return true;
    if (e.key === "Enter") {
      const s = app.loadout.sides[m.side][m.index]!;
      s.persona = m.cursor === 0 ? null : PERSONA_KEYS[m.cursor - 1]!;
      close();
      return true;
    }
    return false;
  }
  if (m.kind === "pilot") {
    if (vertical(3)) return true;
    const s = app.loadout.sides[m.side][m.index]!;
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d !== 0) {
      if (m.cursor === 0) s.gunnery = Math.max(0, Math.min(7, s.gunnery + d));
      else if (m.cursor === 1) s.piloting = Math.max(0, Math.min(7, s.piloting + d));
      else s.pilotHitMax = Math.max(1, Math.min(6, s.pilotHitMax + d));
      return true;
    }
    const presets: Record<string, [number, number]> = {
      Digit1: [5, 6],
      Digit2: [4, 5],
      Digit3: [3, 4],
      Digit4: [2, 3],
    };
    const p = presets[e.code];
    if (p) {
      [s.gunnery, s.piloting] = p;
      return true;
    }
    if (e.key === "Enter") close();
    return e.key === "Enter";
  }
  if (m.kind === "policy") {
    if (vertical(4)) return true;
    const s = app.loadout.sides[m.side][m.index]!;
    const d = e.key === "ArrowRight" || e.key === " " ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d !== 0) {
      policyItems(s)[m.cursor]![2](d);
      return true;
    }
    if (e.key === "Enter") close();
    return e.key === "Enter";
  }
  if (m.kind === "generate") {
    if (vertical(3)) return true;
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d !== 0) {
      if (m.cursor === 0) m.count = Math.max(1, Math.min(MAX_SLOTS, m.count + d));
      else if (m.cursor === 1) m.match = (m.match + 1) % 2;
      else m.personas = (m.personas + 1) % 2;
      return true;
    }
    if (e.key === "Enter") {
      const other = app.loadout.sides[(1 - m.side) as 0 | 1];
      const rng = createRng((Date.now() & 0x7fffffff) >>> 0);
      const slots = generateSide(rng, {
        count: m.count,
        bvTarget: m.match === 0 ? sideBv(other) : 0,
        classes: [],
        personas: m.personas === 0 ? "random" : "none",
      });
      if (slots.length > 0) app.loadout.sides[m.side] = slots;
      app.cursors.side[m.side] = 0;
      close();
      return true;
    }
    return false;
  }
  return false;
}

function mechKey(e: KeyboardEvent, m: Extract<Modal, { kind: "mech" }>): boolean {
  const f = m.filter;
  const list = filterMechs(f);
  if (m.field === 0) {
    // typing into the name search
    if (e.key === "Escape" || e.key === "Enter") m.field = -1;
    else if (e.key === "Backspace") f.text = f.text.slice(0, -1);
    else if (e.key.length === 1) f.text += e.key;
    else return false;
    m.cursor = 0;
    return true;
  }
  if (e.key === "Escape") app.modal = null;
  else if (e.key === "/") m.field = 0;
  else if (e.key === "ArrowDown") m.cursor = Math.min(list.length - 1, m.cursor + 1);
  else if (e.key === "ArrowUp") m.cursor = Math.max(0, m.cursor - 1);
  else if (e.key === "PageDown") m.cursor = Math.min(list.length - 1, m.cursor + 20);
  else if (e.key === "PageUp") m.cursor = Math.max(0, m.cursor - 20);
  else if (e.key === "Home") m.cursor = 0;
  else if (e.key === "End") m.cursor = list.length - 1;
  else if (e.key === "Enter") {
    const sel = list[m.cursor];
    if (sel) chooseMech(m, sel.model);
  } else if (/^Digit[1-4]$/.test(e.code)) {
    const c = CLASSES[Number(e.code.slice(5)) - 1]!;
    f.classes = f.classes.includes(c) ? f.classes.filter((x) => x !== c) : [...f.classes, c];
    m.cursor = 0;
  } else if (e.code === "KeyT") {
    f.tech = f.tech === "any" ? "is" : f.tech === "is" ? "clan" : "any";
    m.cursor = 0;
  } else if (e.code === "KeyK") {
    f.pack = f.pack === "any" ? "base" : f.pack === "base" ? "sw" : "any";
    m.cursor = 0;
  } else if (e.code === "KeyE") {
    f.introMax = ERAS[(ERAS.indexOf(f.introMax) + 1) % ERAS.length]!;
    m.cursor = 0;
  } else if (e.code === "KeyS") {
    const sorts = ["ton", "name", "bv", "intro"] as const;
    f.sort = sorts[(sorts.indexOf(f.sort) + 1) % sorts.length]!;
  } else return false;
  return true;
}

/** Map preview for the Map tab: the persistent canvas shows the cursor map. */
export function setupMapPreview(): void {
  if (app.tab !== 2 || !app.mapView) return;
  const name = mapNames()[app.cursors.map];
  if (!name) return;
  const map = ensureMapRegistered(name);
  if (map) app.mapView.setMap(mapSource(map));
  app.mapView.overlays = {};
  app.mapView.banners = [];
}
