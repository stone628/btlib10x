/**
 * bt10x Instant Action (docs/INSTANT.md): boot, the root prefab,
 * the screen router and the global keymap. Depends only on the engine
 * (`btlib10x`) and the TUI kit (`window.TUI`).
 */
import { appendCatalog, ensureMapRegistered, loadCatalog, VERSION } from "btlib10x";
import { applyScreenView, ensureMapView, pumpAi } from "./flow";
import { initLocale, type LocaleId, locale, setLocale, t } from "./i18n";
import { commitAlias, initInput, mapKey, stepFocus } from "./input";
import motdText from "./MOTD.txt";
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
import { focusAfterRender, queueAfterRender } from "./screens/battle.hud";
import { h, kit, row } from "./screens/common";
import { debriefKey, debriefOverlays, debriefScreen } from "./screens/debrief";
import {
  deployAfterRender,
  deployArrow,
  deployKey,
  deployOverlays,
  deployScreen,
} from "./screens/deploy";
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
import { APP_VERSION, ENGINE_BUILT_WITH, engineMismatch } from "./version";

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
  // a kit dialog opened from a menu holds the focus; give it back once it closes
  if (kitModal.open) return;
  const has = app.modal !== null;
  if (has && !hadModal) {
    const el = document.activeElement;
    const outside = el instanceof HTMLElement && el.closest("#app") && !el.closest(".ia-modal");
    opener = outside ? el : lastFocus;
    // the control left behind (a dropdown, a button) must not take the menu's keys
    if (outside) el.blur();
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
  else if (app.screen === "battle") focusAfterRender();
  const slot = document.querySelector<HTMLElement>("#app .ia-mapslot");
  // Map tooltips and framing only where a screen's overlays set them (battle, debrief Map tab).
  if (app.mapView) {
    app.mapView.tipFor = null;
    app.mapView.reframe = null;
  }
  if (!slot) {
    app.mapView?.hideTip();
    return;
  }
  const view = ensureMapView();
  applyScreenView(view);
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
  // a menu or dialog hides the hex tip (it would sit on top); the reticle's comes back after
  if (!view.tipFor || app.modal || kitModal.open) view.hideTip();
  else if (view.reticle) view.showReticle();
  view.render();
}

function rerender(): void {
  if (!scene) return;
  void scene.update({ tick: ++tick }).then(afterRender);
}

function onKey(raw: KeyboardEvent): void {
  if (motdDialog?.open) {
    // the MOTD owns the keys; the pad's B (Backspace) and a synthetic Esc close it
    if (raw.key === "Backspace" || raw.key === "Escape") {
      raw.preventDefault();
      motdDialog.close();
    }
    return;
  }
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
  // commit button, which takes only F10 or a click, and an open Esc menu or
  // Options. A kit menu always keeps its key: the title menu's Enter that opens
  // Options must not reach Options too.
  const nav = ["Enter", " ", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key);
  // Deployment keeps ↑ ↓ for its unit list while one of its buttons has the focus.
  const unitKeys = app.screen === "deploy" && (e.key === "ArrowUp" || e.key === "ArrowDown");
  const escMenu = app.modal?.kind === "menu" || app.modal?.kind === "options";
  if (
    nav &&
    !unitKeys &&
    target?.matches('button, [data-tui="menu"]') &&
    (!escMenu || target.matches('[data-tui="menu"]'))
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
  if (!handled && raw.key === "Tab") {
    stepFocus(raw.shiftKey ? -1 : 1);
    raw.preventDefault();
    return;
  }
  // Backspace never leaves the page
  if (handled || raw.key === "Backspace") raw.preventDefault();
  if (handled) rerender();
}

/** New Battle and deployment arrows go ahead of the kit's select keys (capture phase). */
function onArrowCapture(e: KeyboardEvent): void {
  if ((app.screen !== "setup" && app.screen !== "deploy") || kitModal.open || motdDialog?.open)
    return;
  if (e.target instanceof HTMLInputElement || (e.target as Element | null)?.closest?.(".tui-popup"))
    return;
  if (!(app.screen === "setup" ? setupArrow(e) : deployArrow(e))) return;
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
    b.toggleAttribute("data-on", b.dataset.lang === locale());
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
  const fs = document.getElementById("fontsize");
  if (fs) fs.title = t("font.size");
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

// MOTD, as on the terminal page: the header button opens a modal <dialog>; ✕,
// Esc (pad B) or a click on the backdrop closes it and gives the focus back to
// the app. A dot on the button marks text this browser has not opened yet
// (hash kept in localStorage, every access guarded).
const MOTD_SEEN_KEY = "bt10x.ia.motd.seen";
const motdDialog = document.getElementById("motd") as HTMLDialogElement | null;

function motdHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function initMotd(): void {
  const open = document.getElementById("motd-open") as HTMLButtonElement | null;
  const close = document.getElementById("motd-close") as HTMLButtonElement | null;
  const dot = document.getElementById("motd-dot");
  const body = document.getElementById("motd-body");
  if (body) body.innerHTML = motdText;
  const version = motdHash(motdText);
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(MOTD_SEEN_KEY);
  } catch {
    // storage unavailable: the MOTD just always counts as unread
  }
  if (dot) dot.hidden = seen === version;
  if (!motdDialog || !open) return;
  const dialog = motdDialog;
  open.addEventListener("click", () => {
    if (dialog.open) return;
    if (close) close.title = t("motd.close");
    // Right-align under the button (the home link sits to its right), but
    // never so far left that the panel runs off screen.
    const panelWidth = Math.min(520, window.innerWidth - 24);
    const right = Math.min(
      window.innerWidth - open.getBoundingClientRect().right,
      window.innerWidth - 12 - panelWidth,
    );
    dialog.style.setProperty("--motd-right", `${Math.max(0, right)}px`);
    closeKitOverlays();
    dialog.showModal();
    open.toggleAttribute("data-on", true);
    if (dot) dot.hidden = true;
    try {
      localStorage.setItem(MOTD_SEEN_KEY, version);
    } catch {
      // storage unavailable: the dot comes back next visit
    }
  });
  close?.addEventListener("click", () => dialog.close());
  // A click whose target is the dialog itself but lands outside its box hit
  // the ::backdrop.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener("close", () => {
    open.toggleAttribute("data-on", false);
    // the button must not keep the focus (Enter would open it again); the
    // browser hands it back after this event, so move it on a tick later
    setTimeout(() => {
      open.blur();
      if (lastFocus?.isConnected) lastFocus.focus();
      rerender();
    }, 0);
  });
}

/** A kit popup or tip left open under the MOTD would sit on top of it. */
function closeKitOverlays(): void {
  const TUI = kit();
  TUI.closePopup();
  TUI.hideTip();
}

/** Hover text on the top-bar version: set only while a stale cached engine is loaded. */
function syncVersionTip(): void {
  const version = document.getElementById("topbar-version");
  if (version && engineMismatch(VERSION)) {
    version.title = t("app.engine.stale", { loaded: VERSION, built: ENGINE_BUILT_WITH });
  }
}

function initHeader(): void {
  const version = document.getElementById("topbar-version");
  // App stamp, then the engine stamp it runs on; a "!" flags a stale cached engine.
  if (version) {
    version.textContent = `v${APP_VERSION} · engine ${VERSION}${engineMismatch(VERSION) ? " !" : ""}`;
  }
  syncVersionTip();
  document.querySelectorAll<HTMLButtonElement>("#lang button").forEach((b) => {
    b.addEventListener("click", () => {
      setLocale(b.dataset.lang as LocaleId);
      syncLangButtons();
      syncVersionTip();
      rerender();
    });
  });
  syncLangButtons();
  initMotd();
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
  app.version = APP_VERSION;
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
