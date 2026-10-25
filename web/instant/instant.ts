/**
 * bt10x Instant Action (docs/INSTANT_ACTION.html): boot, the root prefab,
 * the screen router and the global keymap. Depends only on the engine
 * (`btlib10x`) and the TUI kit (`window.TUI`).
 */
import { appendCatalog, ensureMapRegistered, loadCatalog, VERSION } from "btlib10x";
import { ensureMapView, pumpAi } from "./flow";
import { initLocale, t } from "./i18n";
import { fitScreen } from "./screen";
import { battleKey, battleOverlays, battleScreen } from "./screens/battle";
import { h, kit, row } from "./screens/common";
import { debriefKey, debriefScreen } from "./screens/debrief";
import { deployKey, deployOverlays, deployScreen } from "./screens/deploy";
import { helpWindow, setupKey, setupMapPreview, setupScreen } from "./screens/setup";
import { titleKey, titleScreen } from "./screens/title";
import { defaultLoadout, loadLoadout } from "./setup/loadout";
import { app, kitModal, setRerender } from "./state";
import type { TuiNode, TuiScene } from "./tui";

let scene: TuiScene | null = null;
let tick = 0;

function rootView(): TuiNode {
  switch (app.screen) {
    case "loading":
      return h().el(
        "div",
        { class: "ia-root" },
        h().box(
          { cols: 100, rows: 31, border: "double" },
          row(app.error ?? t("loading"), { cls: app.error ? "ia-err" : "" }),
        ),
      );
    case "title":
      return h().el(
        "div",
        { class: "ia-root" },
        titleScreen(),
        app.modal?.kind === "help" ? helpWindow() : null,
      );
    case "setup":
      return setupScreen();
    case "deploy":
      return deployScreen();
    case "battle":
      return battleScreen();
    case "debrief":
      return debriefScreen();
  }
}

/** After each render: put the persistent map canvas into its slot and paint it. */
function afterRender(): void {
  const slot = document.querySelector<HTMLElement>("#app .ia-mapslot");
  if (!slot) return;
  const view = ensureMapView();
  if (view.canvas.parentElement !== slot) slot.replaceChildren(view.canvas);
  if (app.screen === "battle") battleOverlays();
  else if (app.screen === "deploy") deployOverlays();
  else if (app.screen === "setup") setupMapPreview();
  view.render();
}

function rerender(): void {
  if (!scene) return;
  void scene.update({ tick: ++tick }).then(afterRender);
}

function onKey(e: KeyboardEvent): void {
  if (app.screen === "loading") return;
  if (kitModal.open) return; // a kit popup or dialog owns the keys
  if (e.target instanceof HTMLInputElement) return;
  let handled = false;
  if (app.screen === "title") {
    if (app.modal) {
      app.modal = null;
      handled = true;
    } else if (e.key === "F1") {
      app.modal = { kind: "help" };
      handled = true;
    } else handled = titleKey(e);
  } else if (app.screen === "setup") {
    if (e.key === "F1" && !app.modal) {
      app.modal = { kind: "help" };
      handled = true;
    } else handled = setupKey(e);
  } else if (app.screen === "deploy") {
    try {
      handled = deployKey(e);
      app.error = null;
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
      handled = true;
    }
  } else if (app.screen === "battle") handled = battleKey(e);
  else if (app.screen === "debrief") {
    handled = debriefKey(e);
    if ((app.screen as string) === "battle") pumpAi();
  }
  if (handled) {
    e.preventDefault();
    rerender();
  }
}

function fetchText(file: string): Promise<string> {
  return fetch(file).then((res) => {
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res.text();
  });
}

async function boot(): Promise<void> {
  initLocale();
  app.version = VERSION;
  document.title = t("doc.title");
  fitScreen();
  const TUI = kit();
  TUI.prefab("ia-app", { tick: 0 }, () => rootView());
  scene = TUI.mount(document.getElementById("app")!, TUI.h.use("ia-app", { tick: 0 }));
  setRerender(rerender);
  window.addEventListener("resize", () => {
    fitScreen();
    rerender();
  });
  void document.fonts?.ready.then(() => {
    fitScreen();
    rerender();
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", () => setTimeout(rerender, 0));
  try {
    loadCatalog(await fetchText("btlib10x.jsonl"));
    await fetchText("btlib10x.sw.jsonl")
      .then((text) => appendCatalog(text, "sw", () => {}))
      .catch((e) => console.warn("SW pack unavailable", e));
    await fetchText("btlib10x.ia.jsonl")
      .then((text) => appendCatalog(text, "ia", () => {}))
      .catch(() => {});
    ensureMapRegistered("quickstart");
    app.loadout = loadLoadout() ?? defaultLoadout();
    app.screen = "title";
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
  }
  rerender();
}

void boot();
