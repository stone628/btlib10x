import { GLYPH_BLOCKS } from "./avatar.glyphs";

/**
 * Per-cell overrides for the mech avatar. Each part variant is 2 characters,
 * `data[0]` drawn on screen left and `data[1]` on screen right; an override
 * replaces one of those cells with a single glyph of the user's choosing.
 *
 * Slot names use the mech's own side: it faces the viewer, so its right
 * (`R*`) is on screen left (`data[0]`).
 */
export type SlotId = "RH" | "LH" | "RS" | "LS" | "RA" | "LA" | "RT" | "LT" | "RL" | "LL";

export interface SlotDef {
  id: SlotId;
  title: string;
  /** Index into the avatar's part order: head, shoulder, torso, arms, legs. */
  part: number;
  /** Which character of the part's 2-char data this slot replaces. */
  side: 0 | 1;
}

/** Tab / storage / export order. */
export const SLOTS: SlotDef[] = [
  { id: "RH", title: "right head", part: 0, side: 0 },
  { id: "LH", title: "left head", part: 0, side: 1 },
  { id: "RS", title: "right shoulder", part: 1, side: 0 },
  { id: "LS", title: "left shoulder", part: 1, side: 1 },
  { id: "RA", title: "right arm", part: 3, side: 0 },
  { id: "LA", title: "left arm", part: 3, side: 1 },
  { id: "RT", title: "right torso", part: 2, side: 0 },
  { id: "LT", title: "left torso", part: 2, side: 1 },
  { id: "RL", title: "right leg", part: 4, side: 0 },
  { id: "LL", title: "left leg", part: 4, side: 1 },
];

export type Overrides = Partial<Record<SlotId, string>>;

/** A glyph shown in place of a slot's current one, not saved. */
export interface Preview {
  slot: SlotId;
  ch: string;
}

/** The "blank" choice: a plain space, offered as its own button rather than in the grid. */
export const BLANK = " ";

const GLYPH_SET: ReadonlySet<number> = new Set([
  BLANK.codePointAt(0)!,
  ...GLYPH_BLOCKS.flatMap((b) =>
    b.ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)),
  ),
]);

/** One code point the subset font maps (or the blank space). */
export function isAllowedGlyph(ch: string): boolean {
  const cps = Array.from(ch);
  return cps.length === 1 && GLYPH_SET.has(ch.codePointAt(0)!);
}

export function slotDef(id: SlotId): SlotDef {
  return SLOTS.find((s) => s.id === id)!;
}

export function isSlotId(v: string): v is SlotId {
  return SLOTS.some((s) => s.id === v);
}

/**
 * Part data with overrides (and an optional preview) applied. `parts` is the
 * 2-char data of each part in avatar order; `skipPart` leaves one part as
 * its variant draws it (the carousel row being browsed).
 */
export function applyOverrides(
  parts: readonly string[],
  ovr: Overrides,
  preview: Preview | null = null,
  skipPart = -1,
): string[] {
  const cells = parts.map((d) => [d[0] ?? " ", d[1] ?? " "]);
  for (const slot of SLOTS) {
    if (slot.part === skipPart) continue;
    const ch = preview?.slot === slot.id ? preview.ch : ovr[slot.id];
    const row = cells[slot.part];
    if (ch !== undefined && row !== undefined) row[slot.side] = ch;
  }
  return cells.map((c) => c.join(""));
}

/** Overrides of one part, in slot order. */
export function partOverrides(ovr: Overrides, part: number): [SlotDef, string][] {
  return SLOTS.filter((s) => s.part === part && ovr[s.id] !== undefined).map((s) => [
    s,
    ovr[s.id]!,
  ]);
}

/** Drop the overrides on one part's slots (a variant was picked for it). */
export function clearPart(ovr: Overrides, part: number): Overrides {
  const out: Overrides = {};
  for (const s of SLOTS) {
    const ch = ovr[s.id];
    if (s.part !== part && ch !== undefined) out[s.id] = ch;
  }
  return out;
}

/** Saved overrides, keeping only known slots holding a glyph the font still has. */
export function parseOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isSlotId(k) && typeof v === "string" && isAllowedGlyph(v)) out[k] = v;
  }
  return out;
}

export function codePointLabel(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Export-line form, `RH=☢ LA=⎬`; the blank shows as its code point. */
export function formatOverrides(ovr: Overrides): string {
  return SLOTS.filter((s) => ovr[s.id] !== undefined)
    .map((s) => {
      const ch = ovr[s.id]!;
      return `${s.id}=${ch === BLANK ? codePointLabel(ch) : ch}`;
    })
    .join(" ");
}
