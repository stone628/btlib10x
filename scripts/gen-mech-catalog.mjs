import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mechsDir = join(root, "src", "data", "mechs");
const outFile = join(root, "src", "data", "mechCatalog.generated.ts");

/**
 * Regenerates the 'Mech catalog module from the mechs/ directory. Every
 * src/data/mechs/*.ts becomes a static import, so adding a 'Mech never
 * requires editing a registration list by hand. Run via `npm run gen:mechs`;
 * the build/typecheck scripts invoke this automatically.
 */
const files = readdirSync(mechsDir)
  .filter((f) => f.endsWith(".ts"))
  .sort();

function ident(filename) {
  // as7-d.ts -> as7dDef (strip non-alnum, ensure not starting with a digit).
  const stripped = filename.replace(/\.ts$/, "").replace(/[^A-Za-z0-9]/g, "");
  const base = stripped && !/^[0-9]/.test(stripped) ? stripped : `mech${stripped}`;
  return `${base}Def`;
}

const imports = files.map((f) => `import ${ident(f)} from "./mechs/${f.replace(/\.ts$/, "")}";`);
const entries = files.map((f) => `    [${ident(f)}.model, ${ident(f)}],`).join("\n");

const content = `/**
 * GENERATED FILE - do not edit by hand. Regenerate with \`npm run gen:mechs\`
 * (build/typecheck run it automatically). Indexes every src/data/mechs/*.ts,
 * resolving each typed MechDef into the engine-facing ResolvedMechDef that
 * keeps front and rear armor as separate pools.
 */
import type { MechDef, ResolvedMechDef } from "./mech.schema";
import { resolveMechDef, validateMechDef } from "./mech.schema";

${imports.join("\n")}

const mechs: readonly [string, MechDef][] = [
${entries}
];

/** All 'Mech definitions shipped with the library, keyed by model. */
export const MECH_DEFS: Readonly<Map<string, ResolvedMechDef>> = new Map<string, ResolvedMechDef>(
  mechs.map(([model, def]) => [model, resolveMechDef(validateMechDef(def))]),
);
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, content);
console.log(`Generated ${outFile} (${files.length} 'Mechs).`);
