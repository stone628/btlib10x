/**
 * Glyph avatars for the map (`view.ts`, `drawGlyph`): catalog model →
 * 10 glyphs, the avatar creator's 4×3 box without its frame, read as rows of
 * 4 (shoulder, head, head, shoulder), 4 (arm, torso, torso, arm) and 2 (legs).
 * Extracted from the Solaris Rogue 'Mech avatar sheet (tabletop art);
 * `default` (the creator's `head=sr&shoulder=no&torso=bs&arms=hlf&legs=hll`)
 * stands in for a model the table does not list.
 */
import AVATARS from "../avatars/mech-avatars.json";

const TABLE: Readonly<Record<string, string>> = AVATARS;

export const DEFAULT_GLYPH = TABLE.default ?? " ╭╮ ╽[]╽╽╽";

/** The glyph avatar of a catalog model, or the default. */
export function glyphOf(model: string): string {
  return TABLE[model] ?? DEFAULT_GLYPH;
}

/** The glyph avatar of a catalog model, or null when the table does not list it (no default). */
export function avatarOf(model: string): string | null {
  return model === "default" ? null : (TABLE[model] ?? null);
}
