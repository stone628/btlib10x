/**
 * The Control dropdown of the Movement and Attack Command panels: Player, or
 * a persona that plays this one prompt (the acting unit's current phase) when
 * F10 commits it. It lapses with the prompt (`BattleController.phasePersona`),
 * and the list is the one Choose Control shows (`setup.persona.ts`).
 */
import type { PersonaKey } from "../ai/persona.data";
import { t } from "../i18n";
import { app, kitModal, rerender } from "../state";
import { UI_THEME } from "../theme";
import { fit, kit } from "./common";
import { CONTROLS, controlName } from "./setup.persona";

const { MARK: M } = UI_THEME;

/** Id of the Control dropdown, where Enter (or ↑ ↓) opens its menu. */
export const CONTROL_ID = "ia-control";

/** `Control: Player`, `Control: Long Tom`, … */
export function controlLabel(): string {
  return `${t("setup.control")}: ${controlName(app.battle?.phasePersona ?? null)}`;
}

/** Id of the dropdown button whose menu is open, or null. */
let openFor: string | null = null;

/**
 * A dropdown menu under `el` over `labels`: the cursor starts on `current`
 * (-1: none); `step` ±1 (↓ / ↑) starts it one after or before it, round the
 * list (nothing current: ↓ the first, ↑ the last). `pick` gets the chosen
 * index, or nothing on cancel. Opening it again from the same button (a
 * second click) closes it, as the kit's own select does. Without a document
 * (tests) nothing opens.
 */
export function openDropdown(
  el: HTMLElement | null,
  labels: readonly string[],
  current: number,
  step: number,
  pick: (index: number) => void,
): void {
  if (!el) return;
  if (openFor !== null && openFor === el.id) {
    kit().closePopup();
    return;
  }
  const n = labels.length;
  const active =
    step === 0
      ? Math.max(0, current)
      : current < 0
        ? step > 0
          ? 0
          : n - 1
        : (current + step + n) % n;
  kitModal.open = true;
  const id = el.id;
  openFor = id;
  void kit()
    .popupMenu(
      el,
      labels.map((label) => ({ label })),
      { active },
    )
    .then((r) => {
      if (openFor === id) openFor = null;
      kitModal.open = false;
      if (r && "index" in r) pick(r.index);
      rerender();
    });
}

/** The element of a dropdown by id, or null without a document (tests). */
export function byId(id: string): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById(id);
}

/** Pick Player (null) or a persona for this prompt. */
export function pickControl(key: PersonaKey | null): void {
  const b = app.battle;
  if (!b) return;
  try {
    b.setPhasePersona(key);
    app.error = null;
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
  }
}

/** Open the Control dropdown under its button. */
export function openControlMenu(step = 0, after?: () => void): void {
  const current = app.battle?.phasePersona ?? null;
  openDropdown(
    byId(CONTROL_ID),
    CONTROLS.map((c) => `${c === current ? M.on : " "} ${fit(controlName(c), 16)}`),
    CONTROLS.indexOf(current),
    step,
    (i) => {
      pickControl(CONTROLS[i] ?? null);
      after?.();
    },
  );
}
