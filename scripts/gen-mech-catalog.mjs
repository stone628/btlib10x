import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const mechsDir = join(dataDir, "mechs");
const mapsDir = join(dataDir, "maps");
const outFile = join(dataDir, "index.ts");

/**
 * Regenerates the data-bundle entry from the raw JSON tables. Every
 * data/mechs/*.json and data/maps/*.json becomes a static import, so adding
 * a 'Mech or map never requires editing a registration list by hand. Run via
 * `npm run gen:mechs`; the data build consumes the result. The engine
 * validates and resolves the raw definitions at load time.
 */
const mechFiles = readdirSync(mechsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const mapFiles = readdirSync(mapsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

function ident(dir, filename) {
  // as7-d.json -> as7dMech (strip non-alnum, ensure not starting with a digit).
  const stripped = filename.replace(/\.json$/, "").replace(/[^A-Za-z0-9]/g, "");
  const base = stripped && !/^[0-9]/.test(stripped) ? stripped : `entry${stripped}`;
  return `${base}${dir === "mechs" ? "Mech" : "Map"}`;
}

const mechImports = mechFiles.map((f) => `import ${ident("mechs", f)} from "./mechs/${f}";`);
const mapImports = mapFiles.map((f) => `import ${ident("maps", f)} from "./maps/${f}";`);
const mechEntries = mechFiles.map((f) => `  ${ident("mechs", f)},`).join("\n");
const mapEntries = mapFiles.map((f) => `  ${ident("maps", f)},`).join("\n");

const content = `/**
 * GENERATED FILE - do not edit by hand. Regenerate with \`npm run gen:mechs\`.
 * Indexes every data/mechs/*.json and data/maps/*.json as raw definitions
 * alongside the weapon/ammo tables. The engine validates and loads them via
 * \`loadShippedData\` (see \`src/data/index.ts\`).
 */
import type { AmmoDef, MapDefSrc, MechDef, WeaponDef } from "btlib10x";
import ammoJson from "./ammo.json";
import weaponsJson from "./weapons.json";

${mechImports.join("\n")}
${mapImports.join("\n")}

/** Raw weapon table shipped with the library; validated at load. */
export const WEAPON_DATA: readonly WeaponDef[] =
  weaponsJson as unknown as readonly WeaponDef[];

/** Raw ammo table shipped with the library; validated at load. */
export const AMMO_DATA: readonly AmmoDef[] = ammoJson as unknown as readonly AmmoDef[];

/** Raw 'Mech definitions shipped with the library; validated at load. */
export const MECH_SRCS: readonly MechDef[] = [
${mechEntries}
] as unknown as readonly MechDef[];

/** Raw map sources shipped with the library; validated at load. */
export const MAP_SRCS: readonly MapDefSrc[] = [
${mapEntries}
] as unknown as readonly MapDefSrc[];
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, content);
console.log(`Generated ${outFile} (${mechFiles.length} 'Mechs, ${mapFiles.length} maps).`);
