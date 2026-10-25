/** Screen 4: debrief (result, units, salvage, log). */
import { isHull, mechDefFor, salvageReport } from "btlib10x";
import { unitLoss } from "../battle/victory";
import { rematch } from "../flow";
import { t } from "../i18n";
import { app } from "../state";
import type { TuiNode } from "../tui";
import { blank, fit, h, logView, row, statusbar, tabBar } from "./common";

const TABS = ["debrief.result", "debrief.units", "debrief.salvage", "battle.log"];

export function debriefScreen(): TuiNode {
  const H = h();
  const b = app.battle!;
  const r = b.result!;
  const head =
    r.winnerTeam === null
      ? t("debrief.draw", { turn: r.turn })
      : t("debrief.wins", { side: r.winnerTeam, turn: r.turn });
  const mode =
    b.mode.kind === "destroyAll"
      ? t("mode.destroyAll")
      : t("mode.damageRaceN", { n: b.mode.turns });
  let body: TuiNode[] = [];
  if (app.tab === 0) {
    body = [
      row(
        `${fit(t("debrief.side"), 8)}${fit(t("debrief.dealt"), 16, "right")}${fit(t("debrief.taken"), 16, "right")}${fit(t("debrief.lost"), 14, "right")}${fit(t("debrief.score"), 22, "right")}`,
        { cls: "ia-dim", key: "h" },
      ),
      row("─".repeat(76), { cls: "ia-dim", key: "hs" }),
      ...r.sides.map((s) =>
        row(
          `${fit(s.team, 8)}${fit(s.dealt, 16, "right")}${fit(s.taken, 16, "right")}${fit(`${s.lost} / ${s.units}`, 14, "right")}${fit(s.score, 22, "right")}`,
          { cls: `ia-team${s.team}`, key: `s${s.team}` },
        ),
      ),
      ...blank(1),
      row(t("debrief.note"), { cls: "ia-dim", key: "note" }),
    ];
  } else if (app.tab === 1) {
    body = Object.values(b.state.units).map((u) => {
      const def = mechDefFor(u);
      const status =
        u.removed === "destroyed"
          ? t("debrief.destroyed")
          : isHull(u)
            ? t(`debrief.hull.${u.removed}`)
            : t("debrief.operational");
      return row(
        fit(
          `${fit(u.id, 4)}${fit(`${def.model} ${def.name}`, 28)}${fit(status, 26)}${t("debrief.lostPts", { n: unitLoss(u, b.totals) })}`,
          96,
        ),
        { cls: `ia-team${u.team}`, key: u.id },
      );
    });
  } else if (app.tab === 2) {
    const report = salvageReport(b.state);
    body =
      report.length === 0
        ? [row(t("debrief.noSalvage"), { cls: "ia-dim", key: "none" })]
        : report
            .slice(0, 24)
            .map((e, i) =>
              row(
                fit(
                  `${fit(e.unitId, 4)}${fit(e.model, 14)}${fit(t(`debrief.kind.${e.kind}`), 12)}(${e.hex.col},${e.hex.row})  ${e.salvageable.length} ${t("debrief.items")}`,
                  96,
                ),
                { key: `sv${i}` },
              ),
            );
  } else {
    body = [logView(b.log, 26, 94)];
  }
  return H.el(
    "div",
    { class: "ia-root" },
    H.box(
      { cols: 100, rows: 31, border: "double", title: `${head} · ${mode}` },
      tabBar(
        TABS.map((k) => t(k)),
        app.tab,
        (i) => {
          app.tab = i;
        },
      ),
      row("─".repeat(96), { cls: "ia-dim", key: "tsep" }),
      H.el(
        "div",
        { class: "ia-log", style: { height: "calc(26 * var(--ch))", overflow: "hidden" } },
        ...body,
      ),
    ),
    statusbar([
      ["Tab", "key.tab"],
      ["R", "key.rematch"],
      ["Enter", "key.setup"],
      ["^Z", "key.backToBattle"],
      ["Esc", "key.title"],
    ]),
  );
}

export function debriefKey(e: KeyboardEvent): boolean {
  const b = app.battle!;
  if (e.key === "Tab") app.tab = (app.tab + (e.shiftKey ? 3 : 1)) % 4;
  else if (e.code === "KeyR") rematch();
  else if (e.key === "Enter") {
    app.screen = "setup";
    app.tab = 0;
  } else if (e.key === "Escape") app.screen = "title";
  else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && b.canUndo) {
    b.undo();
    app.screen = "battle";
  } else return false;
  return true;
}
