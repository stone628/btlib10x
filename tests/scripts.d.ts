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
      | { kind: "structure"; name: string }
      | { kind: "soak"; name: string }
    >
  >;

  export function parseCritSlots(lines: string[], errors: string[], fileLabel: string): CritSlotMap;

  export function validateCritConstruction(
    slots: CritSlotMap,
    meta: {
      techBase?: string;
      engineField?: string;
      structureField?: string;
      armorField?: string;
    },
    errors: string[],
  ): void;
}
