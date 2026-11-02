/**
 * Ambient types for the plain-JS (dev-only) MTF crit-slot scripts, which are
 * deliberately excluded from `tsc` (scripts/ isn't in tsconfig `include`).
 * Tests import them for coverage, so give the imported surface explicit
 * declarations rather than falling back to `any`.
 */
declare module "*/mtf-crit.mjs" {
  export type CritSlotMap = Record<
    string,
    Array<
      | { kind: "empty" }
      | { kind: "weapon"; weapon: string }
      | { kind: "ammo"; weapon: string }
      | { kind: "structure"; type: string; name?: string }
      | { kind: "soak"; name: string }
    >
  >;

  export function parseCritSlots(
    lines: string[],
    errors: string[],
    fileLabel: string,
    techBase?: string,
  ): CritSlotMap;

  export function validateCritConstruction(
    slots: CritSlotMap,
    meta: {
      techBase?: string;
      engineField?: string;
      structureField?: string;
      armorField?: string;
      myomer?: string;
    },
    errors: string[],
  ): void;

  /** Per-catalog-weapon ammo tonnage tally. Full-ton crits add 1, "- Half"
   * suffixed crits add 0.5. Caller multiplies by SHOTS_PER_TON to get shots. */
  export function ammoBinsFromCrits(lines: string[], techBase?: string): Map<string, number>;
}

declare module "*/mtf.mjs" {
  export function parseMtf(
    text: string,
    file: string,
  ): {
    def: {
      weapons: Array<{
        weapon: string;
        location: string;
        shots?: number;
        rearFacing?: boolean;
      }>;
      [key: string]: unknown;
    } | null;
    errors: string[];
  };
}

declare module "*/build-stamp.mjs" {
  export const STAMP_PATHS: Record<"engine" | "terminal" | "instant", string[]>;
  export function buildStamp(paths?: string[]): string;
  export function componentStamps(): Record<"engine" | "terminal" | "instant", string>;
}
