import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mechsDir = join(root, "src", "data", "mechs");
const outFile = join(root, "src", "data", "mechCatalog.generated.ts");

/**
 * Regenerates the 'Mech catalog module from the mechs/ directory. Every
 * src/data/mechs/*.json becomes a static import, so adding a 'Mech never
 * requires editing a registration list by hand. Run via `npm run gen:mechs`;
 * the build/typecheck scripts invoke this automatically.
 */
const files = readdirSync(mechsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

function ident(filename) {
  // as7-d.json -> as7dJson (strip non-alnum, ensure not starting with a digit).
  const stripped = filename.replace(/\.json$/, "").replace(/[^A-Za-z0-9]/g, "");
  const base = stripped && !/^[0-9]/.test(stripped) ? stripped : `mech${stripped}`;
  return `${base}Json`;
}

const imports = files.map((f) => `import ${ident(f)} from "./mechs/${f}";`);
const values = files.map((f) => `    ${ident(f)},`).join("\n");

const content = `/**
 * GENERATED FILE - do not edit by hand. Regenerate with \`npm run gen:mechs\`
 * (build/typecheck run it automatically). Indexes every src/data/mechs/*.json,
 * validating each against the raw JSON schema and resolving it into the
 * engine-facing definition that keeps front and rear armor as separate pools.
 */
import type { ResolvedMechDef } from "./schema.js";
import { resolveMechDef, validateMechDef } from "./schema.js";

const load = (data: unknown): ResolvedMechDef => resolveMechDef(validateMechDef(data));

${imports.join("\n")}

/** All 'Mech definitions shipped with the library, keyed by model. */
export const MECH_DEFS: Readonly<Record<string, ResolvedMechDef>> = Object.fromEntries(
  [
${values}
  ].map((data) => {
    const def = load(data);
    return [def.model, def];
  }),
);
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, content);
console.log(`Generated ${outFile} (${files.length} 'Mechs).`);
