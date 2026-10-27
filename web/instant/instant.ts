/**
 * bt10x Instant Action (docs/INSTANT_ACTION.html): boot, the root prefab,
 * the screen router and the global keymap. Depends only on the engine
 * (`btlib10x`) and the TUI kit (`window.TUI`).
 */
import { appendCatalog, ensureMapRegistered, loadCatalog, VERSION } from "btlib10x";
import { ensureMapView, pumpAi } from "./flow";
import { initLocale, type LocaleId, locale, setLocale, t } from "./i18n";
import { fitScreen } from "./screen";
import { battleKey, battleOverlays, battleScreen } from "./screens/battle";
import { h, kit, row } from "./screens/common";
import { debriefKey, debriefScreen } from "./screens/debrief";
import { deployKey, deployOverlays, deployScreen } from "./screens/deploy";
import {
  helpWindow,
  setupAfterRender,
  setupKey,
  setupMapPreview,
  setupScreen,
} from "./screens/setup";
import { titleAfterRender, titleScreen } from "./screens/title";
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
  // Logs stick to their newest line unless the reader scrolled up.
  document.querySelectorAll<HTMLElement>("#app .ia-logscroll").forEach((el) => {
    if (el.dataset.pinned !== "false") el.scrollTop = el.scrollHeight;
    el.onscroll = () => {
      el.dataset.pinned = String(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
    };
  });
  if (app.screen === "setup") setupAfterRender();
  else if (app.screen === "title") titleAfterRender();
  const slot = document.querySelector<HTMLElement>("#app .ia-mapslot");
  if (!slot) return;
  const view = ensureMapView();
  if (view.canvas.parentElement !== slot) {
    slot.replaceChildren(view.canvas);
    view.clearHover();
  }
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
  // Kit controls own their keys: popups, menus, and Enter / Space / arrows
  // on a focused button or select (the browser presses it, the kit opens it).
  const target = e.target instanceof Element ? e.target : null;
  const nav = ["Enter", " ", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key);
  if (target?.closest(".tui-popup")) return;
  if (nav && target?.matches('button, [data-tui="menu"]')) return;
  let handled = false;
  if (app.screen === "title") {
    if (app.modal) {
      app.modal = null;
      handled = true;
    } else if (e.key === "F1") {
      app.modal = { kind: "help" };
      handled = true;
    }
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

/** Header language buttons (as on the landing page): EN / 한국어. */
function syncLangButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("#lang button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === locale()));
  });
  document.title = t("doc.title");
}

function initHeader(): void {
  const version = document.getElementById("topbar-version");
  if (version) version.textContent = `v${VERSION}`;
  document.querySelectorAll<HTMLButtonElement>("#lang button").forEach((b) => {
    b.addEventListener("click", () => {
      setLocale(b.dataset.lang as LocaleId);
      syncLangButtons();
      rerender();
    });
  });
  syncLangButtons();
}

async function boot(): Promise<void> {
  initLocale();
  app.version = VERSION;
  initHeader();
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
