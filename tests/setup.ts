/**
 * Vitest setup: load the unified catalog (`data/btlib10x.jsonl`) into the
 * engine registries. Rule tests import `../src/*` directly, while the web
 * layer (`../web/terminal/*`) resolves `btlib10x` through package exports to `dist/`
 * — both copies need loading. Run `npm run build` first so `dist/`
 * matches `src/`.
 *
 * Tests register the whole catalog (unlike production, which registers on
 * demand) so sheet-iteration assertions keep working unchanged.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
// Also load into dist module (used by web tests via package exports)
import { loadCatalog as loadCatalogDist } from "btlib10x";
import { registerAllCatalog as registerAllCatalogDist } from "../dist/data/catalog.js";
import { loadCatalog } from "../src";
import { registerAllCatalog } from "../src/data/catalog";

const TEXT = readFileSync(new URL("../data/btlib10x.jsonl", import.meta.url), "utf8");

loadCatalog(TEXT);
registerAllCatalog();
// Load into dist module as well
loadCatalogDist(TEXT);
registerAllCatalogDist();
