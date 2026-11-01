/**
 * bt10x Instant Action (docs/INSTANT.md): boot, the root prefab,
 * the screen router and the global keymap. Depends only on the engine
 * (`btlib10x`) and the TUI kit (`window.TUI`).
 */
import { appendCatalog, ensureMapRegistered, loadCatalog, VERSION } from "btlib10x";
import { ensureMapView, pumpAi } from "./flow";
import { initLocale, type LocaleId, locale, setLocale, t } from "./i18n";
import { commitAlias, initInput, mapKey } from "./input";
import {
  fitFontSize,
  fontSize,
  initFontSize,
  MAX_FS,
  MIN_FS,
  onFontSize,
  setFontSize,
} from "./screen";
import { battleKey, battleOverlays, battleScreen } from "./screens/battle";
import { queueAfterRender } from "./screens/battle.hud";
import { h, kit, row } from "./screens/common";
import { debriefKey, debriefOverlays, debriefScreen } from "./screens/debrief";
import { deployAfterRender, deployKey, deployOverlays, deployScreen } from "./screens/deploy";
import {
  setupAfterRender,
  setupArrow,
  setupKey,
  setupMapPreview,
  setupScreen,
} from "./screens/setup";
import { titleAfterRender, titleKey, titleScreen } from "./screens/title";
import { emptyLoadout } from "./setup/loadout";
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
      return h().el("div", { class: "ia-root" }, titleScreen());
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
/** Last focused control outside a dialog, and the one that opened the open dialog. */
let lastFocus: HTMLElement | null = null;
let opener: HTMLElement | null = null;
let hadModal = false;

/** A dialog that opened from a control gives the focus back to it when it closes. */
function restoreFocus(): void {
  const has = app.modal !== null;
  if (has && !hadModal) {
    const el = document.activeElement;
    opener =
      el instanceof HTMLElement && el.closest("#app") && !el.closest(".ia-modal") ? el : lastFocus;
  } else if (!has && hadModal) {
    if (opener?.isConnected) opener.focus();
    opener = null;
  }
  hadModal = has;
}

function afterRender(): void {
  restoreFocus();
  // Logs stick to their newest line unless the reader scrolled up.
  document.querySelectorAll<HTMLElement>("#app .ia-logscroll").forEach((el) => {
    if (el.dataset.pinned !== "false") el.scrollTop = el.scrollHeight;
    el.onscroll = () => {
      el.dataset.pinned = String(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
    };
  });
  if (app.screen === "setup") setupAfterRender();
  else if (app.screen === "title") titleAfterRender();
  else if (app.screen === "deploy") deployAfterRender();
  const slot = document.querySelector<HTMLElement>("#app .ia-mapslot");
  // Map tooltips only where a screen's overlays set tipFor (battle, debrief Map tab).
  if (app.mapView) app.mapView.tipFor = null;
  if (!slot) {
    app.mapView?.hideTip();
    return;
  }
  const view = ensureMapView();
  if (view.canvas.parentElement !== slot) {
    slot.replaceChildren(view.canvas);
    view.clearHover();
  }
  if (app.screen === "battle") {
    battleOverlays();
    queueAfterRender();
  } else if (app.screen === "deploy") deployOverlays();
  else if (app.screen === "setup") setupMapPreview();
  else if (app.screen === "debrief") debriefOverlays();
  if (!view.tipFor) view.hideTip();
  view.render();
}

function rerender(): void {
  if (!scene) return;
  void scene.update({ tick: ++tick }).then(afterRender);
}

function onKey(raw: KeyboardEvent): void {
  if (app.screen === "loading") return;
  if (raw.target instanceof HTMLInputElement) return; // text boxes keep their keys
  const target = raw.target instanceof Element ? raw.target : null;
  // Backspace (B) is Esc in a kit dialog or popup.
  if (raw.key === "Backspace" && (kitModal.open || target?.closest(".tui-popup"))) {
    raw.preventDefault();
    (target ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
    return;
  }
  if (kitModal.open) return; // a kit popup or dialog owns the keys
  if (target?.closest(".tui-popup")) return;
  const e = commitAlias(raw);
  if (e !== raw) raw.preventDefault(); // Shift+Enter never presses a focused button
  if (mapKey(e)) {
    raw.preventDefault();
    rerender();
    return;
  }
  // Kit controls own their keys: menus, and Enter / Space / arrows on a focused
  // button or select (the browser presses it, the kit opens it), except a
  // commit button, which takes only F10 or a click, and an open Esc menu.
  const nav = ["Enter", " ", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key);
  // Deployment keeps ↑ ↓ for its unit list while one of its buttons has the focus.
  const unitKeys = app.screen === "deploy" && (e.key === "ArrowUp" || e.key === "ArrowDown");
  if (
    nav &&
    !unitKeys &&
    app.modal?.kind !== "menu" &&
    target?.matches('button, [data-tui="menu"]')
  ) {
    if ((e.key === "Enter" || e.key === " ") && target.closest("[data-commit]"))
      raw.preventDefault();
    return;
  }
  let handled = false;
  if (app.screen === "title") handled = titleKey(e);
  else if (app.screen === "setup") handled = setupKey(e);
  else if (app.screen === "deploy") {
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
  // Backspace never leaves the page
  if (handled || raw.key === "Backspace") raw.preventDefault();
  if (handled) rerender();
}

/** New Battle arrows go ahead of the kit's select keys (capture phase). */
function onArrowCapture(e: KeyboardEvent): void {
  if (app.screen !== "setup" || kitModal.open) return;
  if (e.target instanceof HTMLInputElement || (e.target as Element | null)?.closest?.(".tui-popup"))
    return;
  if (!setupArrow(e)) return;
  e.preventDefault();
  e.stopPropagation();
  rerender();
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
  const label: Record<string, string> = {
    "-1": t("font.smaller"),
    "1": t("font.larger"),
    fit: t("font.fit.tip"),
  };
  document.querySelectorAll<HTMLButtonElement>("#fontsize button").forEach((b) => {
    b.title = label[b.dataset.fs ?? ""] ?? "";
    if (b.dataset.fs === "fit") b.textContent = t("font.fit");
  });
  document.getElementById("fontsize")?.setAttribute("aria-label", t("font.size"));
}

/** Header font size: A− / readout / A+ / Fit. */
function syncFontButtons(): void {
  const size = fontSize();
  const out = document.getElementById("fontsize-value");
  if (out) out.textContent = String(size);
  document.querySelectorAll<HTMLButtonElement>("#fontsize button").forEach((b) => {
    if (b.dataset.fs === "-1") b.disabled = size <= MIN_FS;
    else if (b.dataset.fs === "1") b.disabled = size >= MAX_FS;
  });
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
  document.querySelectorAll<HTMLButtonElement>("#fontsize button").forEach((b) => {
    b.addEventListener("click", () => {
      const step = b.dataset.fs;
      setFontSize(step === "fit" ? fitFontSize() : fontSize() + Number(step));
    });
  });
  onFontSize((size, old) => {
    // a zoomed map keeps its framing: hexes scale with the cells
    app.mapView?.rescale(size / old);
    syncFontButtons();
    rerender();
  });
}

async function boot(): Promise<void> {
  initLocale();
  app.version = VERSION;
  initHeader();
  initFontSize();
  syncFontButtons();
  const TUI = kit();
  TUI.prefab("ia-app", { tick: 0 }, () => rootView());
  scene = TUI.mount(document.getElementById("app")!, TUI.h.use("ia-app", { tick: 0 }));
  setRerender(rerender);
  // The font size stays put on resize; the map repaints (browser zoom changes
  // devicePixelRatio). The kit re-measures on its own.
  window.addEventListener("resize", () => rerender());
  void document.fonts?.ready.then(() => rerender());
  // Popups and tips are placed in the viewport once: a scrolled stage drops them.
  document.getElementById("stage")?.addEventListener("scroll", () => {
    TUI.closePopup();
    TUI.hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el instanceof HTMLElement && el.closest("#app") && !el.closest(".ia-modal")) lastFocus = el;
  });
  document.addEventListener("keydown", onArrowCapture, true);
  document.addEventListener("keydown", onKey);
  initInput();
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
    app.loadout = emptyLoadout();
    app.screen = "title";
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
  }
  rerender();
}

void boot();
