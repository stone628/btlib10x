/** Screen 2: deployment (TW p. 256 roll-off, home edges, placement). */
import { type Facing, rotateFacing } from "btlib10x";
import { EDGES, edgeHexes } from "../battle/deploy";
import {
  autoPlaceAll,
  beginBattle,
  chooseEdge,
  currentMap,
  deployBanners,
  deployUnits,
  placeUnit,
  sideHasPlayer,
} from "../flow";
import { t } from "../i18n";
import { app, rerender } from "../state";
import type { TuiNode } from "../tui";
import { blank, fit, h, mapSlot, row, statusbar } from "./common";

export function deployScreen(): TuiNode {
  const H = h();
  const d = app.deploy!;
  const winner = d.roll.winner;
  const choosing = d.edges[0] === null;
  const side: TuiNode[] = [
    row(t("deploy.homeEdges"), { cls: "ia-bright", key: "he" }),
    row(
      fit(t("deploy.rolls", { rolls: d.roll.rolls.map(([a, b]) => `${a}:${b}`).join(", ") }), 29),
      { key: "rolls" },
    ),
    row(fit(t("deploy.winner", { side: winner }), 29), { key: "win" }),
  ];
  if (choosing) {
    side.push(row(fit(t("deploy.choose"), 29), { cls: "ia-accent", key: "ch" }));
    EDGES.forEach((e, i) => {
      side.push(
        row(`${i === d.edgeCursor ? "▸" : " "} ${i + 1} ${t(`edge.${e}`)}`, {
          sel: i === d.edgeCursor,
          key: e,
          onClick: () => chooseEdge(e),
        }),
      );
    });
  } else {
    side.push(
      row(fit(`${t("setup.side1")}: ${t(`edge.${d.edges[0]}`)}`, 29), {
        cls: "ia-team1",
        key: "e1",
      }),
      row(fit(`${t("setup.side2")}: ${t(`edge.${d.edges[1]}`)}`, 29), {
        cls: "ia-team2",
        key: "e2",
      }),
      ...blank(1),
      row(t("deploy.toPlace"), { cls: "ia-bright", key: "tp" }),
    );
    deployUnits(app.loadout).forEach((u, i) => {
      const p = d.placements[u.id];
      const where = p
        ? `(${String(p.hex.col).padStart(2, "0")},${String(p.hex.row).padStart(2, "0")}) ${p.facing.toUpperCase()}`
        : t("deploy.notPlaced");
      side.push(
        row(
          `${i === d.cursor ? "▸" : " "}${fit(u.id, 3)} ${fit(u.model, 9)}${u.player ? " " : "*"}${fit(where, 12, "right")}`,
          {
            sel: i === d.cursor,
            cls: u.side === 0 ? "ia-team1" : "ia-team2",
            key: u.id,
            onClick: () => {
              d.cursor = i;
            },
          },
        ),
      );
    });
    side.push(...blank(1), row(fit(t("deploy.aiMark"), 29), { cls: "ia-dim", key: "aim" }));
  }
  side.push(
    ...blank(1),
    row(fit(t("deploy.free"), 29), { cls: "ia-dim", key: "free" }),
    row(fit(t("deploy.tw"), 29), { cls: "ia-dim", key: "tw" }),
  );
  return H.el(
    "div",
    { class: "ia-root" },
    H.split(
      { cols: 100, rows: 31, border: "double", sizes: "1fr 31" },
      H.pane({ title: t("deploy.title", { map: app.loadout.map }), pad: 0 }, mapSlot()),
      H.pane(t("deploy.side"), ...side),
    ),
    statusbar(
      choosing
        ? [
            ["1-4", "key.edge"],
            ["Enter", "key.ok"],
            ["Esc", "key.setup"],
          ]
        : [
            ["↑↓", "key.unit"],
            ["[ ]", "key.facing"],
            ["A", "key.autoPlace"],
            ["Enter", "key.begin"],
            ["Esc", "key.setup"],
          ],
      t("deploy.mouse"),
    ),
  );
}

/** Map overlays for the deploy screen: home-edge zones and placed units. */
export function deployOverlays(): void {
  const v = app.mapView;
  const d = app.deploy;
  if (!v || !d) return;
  const map = currentMap();
  const zone = new Map<string, number>();
  d.edges.forEach((e, s) => {
    if (e) for (const hx of edgeHexes(map, e)) zone.set(`${hx.col},${hx.row}`, s + 1);
  });
  v.overlays = { deploy: zone };
  v.banners = deployBanners();
  v.onPick = (hex) => {
    const unit = deployUnits(app.loadout)[d.cursor];
    if (!unit || d.edges[0] === null) return;
    try {
      placeUnit(unit.id, hex);
      app.error = null;
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    }
    rerender();
  };
}

export function deployKey(e: KeyboardEvent): boolean {
  const d = app.deploy!;
  if (e.key === "Escape") {
    app.screen = "setup";
    app.deploy = null;
    return true;
  }
  if (d.edges[0] === null) {
    if (!sideHasPlayer(app.loadout, (d.roll.winner - 1) as 0 | 1)) return false;
    if (e.key === "ArrowDown") d.edgeCursor = (d.edgeCursor + 1) % 4;
    else if (e.key === "ArrowUp") d.edgeCursor = (d.edgeCursor + 3) % 4;
    else if (e.key === "Enter") chooseEdge(EDGES[d.edgeCursor]!);
    else if (/^Digit[1-4]$/.test(e.code)) chooseEdge(EDGES[Number(e.code.slice(5)) - 1]!);
    else return false;
    return true;
  }
  const units = deployUnits(app.loadout);
  const unit = units[d.cursor];
  if (e.key === "ArrowDown") d.cursor = (d.cursor + 1) % units.length;
  else if (e.key === "ArrowUp") d.cursor = (d.cursor + units.length - 1) % units.length;
  else if ((e.key === "[" || e.key === "]") && unit) {
    const p = d.placements[unit.id];
    if (p) p.facing = rotateFacing(p.facing, e.key === "]" ? 1 : -1) as Facing;
  } else if (e.code === "KeyA" && unit) autoPlaceAll(unit.side);
  else if (e.key === "Enter") beginBattle();
  else return false;
  return true;
}
