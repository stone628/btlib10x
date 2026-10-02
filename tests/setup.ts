/**
 * Vitest setup: load the unified catalog (`data/btlib10x.jsonl`) into the
 * engine registries. Rule tests import `../src/*` directly, while the web
 * layer (`../web/*`) resolves `btlib10x` through package exports to `dist/`
 * — both copies need loading. Run `npm run build` first so `dist/`
 * matches `src/`.
 *
 * Tests register the whole catalog (unlike production, which registers on
 * demand) so sheet-iteration assertions keep working unchanged.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { loadCatalog as loadDistCatalog, registerAllCatalog as registerAllDist } from "btlib10x";
import { loadCatalog as loadSrcCatalog, registerAllCatalog as registerAllSrc } from "../src/index";

const TEXT = readFileSync(new URL("../data/btlib10x.jsonl", import.meta.url), "utf8");

loadSrcCatalog(TEXT);
registerAllSrc();
loadDistCatalog(TEXT);
registerAllDist();
