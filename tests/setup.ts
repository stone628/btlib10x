/**
 * Vitest setup: load the catalog packs (`data/btlib10x.jsonl` as `base`,
 * `docs/mtf/sw/sw.jsonl` as `sw`) into the engine registries. Rule tests
 * import `../src/*` directly, while the web layer (`../web/terminal/*`)
 * resolves `btlib10x` through package exports to `dist/` — both copies
 * need loading. Run `npm run build` first so `dist/` matches `src/`.
 *
 * Tests register the whole catalog (unlike production, which registers on
 * demand) so sheet-iteration assertions keep working unchanged.
 * Cross-pack duplicates are expected (`base` loses to `sw`) and ignored.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
// Also load into dist module (used by web tests via package exports)
import { appendCatalog as appendCatalogDist, loadCatalog as loadCatalogDist } from "btlib10x";
import { registerAllCatalog as registerAllCatalogDist } from "../dist/data/catalog.js";
import { loadCatalog } from "../src";
import { appendCatalog, registerAllCatalog } from "../src/data/catalog";

const TEXT = readFileSync(new URL("../data/btlib10x.jsonl", import.meta.url), "utf8");
const SW_TEXT = readFileSync(new URL("../docs/mtf/sw/sw.jsonl", import.meta.url), "utf8");

loadCatalog(TEXT);
appendCatalog(SW_TEXT, "sw", () => {});
registerAllCatalog();
// Load into dist module as well
loadCatalogDist(TEXT);
appendCatalogDist(SW_TEXT, "sw", () => {});
registerAllCatalogDist();
