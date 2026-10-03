/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allMapDefs,
  allMechDefs,
  type CatalogManifest,
  type CatalogStringTable,
  decodeMapLine,
  decodeMechLine,
  ensureMapRegistered,
  ensureMechRegistered,
  findMapEntry,
  findMechEntry,
  loadCatalog,
  mechDefFor,
  parseCatalogManifest,
  parseCatalogStrings,
  registerAllCatalog,
  registerMap,
  registerMech,
  weightClassForTonnage,
} from "../src/data/index";
import { purgeMechDefs } from "../src/data/mech.schema";

const TEXT = readFileSync(new URL("../data/btlib10x.jsonl", import.meta.url), "utf8");
const STRINGS: CatalogStringTable = parseCatalogStrings(JSON.parse(TEXT.split("\n")[0]!));
const MANIFEST: CatalogManifest = loadCatalog(TEXT);
const LINES = TEXT.split("\n");

function mechLine(entry: { line: number }): string {
  return LINES[entry.line]!;
}

describe("catalog manifest", () => {
  it("packs every sheet and map exactly once, with line-exact ranges", () => {
    expect(MANIFEST.version).toBe(1);
    expect(MANIFEST.mechs.length).toBeGreaterThan(1);
    expect(MANIFEST.maps.length).toBeGreaterThan(0);
    const models = new Set<string>();
    for (const entry of MANIFEST.mechs) {
      const def = decodeMechLine(mechLine(entry), entry, STRINGS);
      expect(def.model).toBe(entry.model);
      expect(def.name).toBe(entry.name);
      expect(def.techBase).toBe(entry.techBase);
      expect(def.tonnage).toBe(entry.tonnage);
      expect(def.weightClass).toBe(weightClassForTonnage(entry.tonnage));
      models.add(entry.model);
    }
    expect(models.size).toBe(MANIFEST.mechs.length);
    const names = new Set<string>();
    for (const entry of MANIFEST.maps) {
      const src = decodeMapLine(LINES[entry.line]!);
      expect(src.name).toBe(entry.name);
      expect(src.width).toBe(entry.width);
      expect(src.height).toBe(entry.height);
      names.add(entry.name);
    }
    expect(names.size).toBe(MANIFEST.maps.length);
  });

  it("round-trips every canonical sheet through the packed wire exactly", () => {
    // Catches encoder (pack-catalog.mjs) / decoder (*.codec.ts) drift:
    // the decoded line must deep-equal the canonical JSON source.
    const mechDir = new URL("../data/mechs/", import.meta.url);
    const mechFiles = readdirSync(mechDir).filter((f) => f.endsWith(".json"));
    expect(mechFiles.length).toBe(MANIFEST.mechs.length);
    for (const entry of MANIFEST.mechs) {
      const decoded = decodeMechLine(mechLine(entry), entry, STRINGS);
      const file = mechFiles.find((f) => f.toLowerCase() === `${entry.model.toLowerCase()}.json`)!;
      expect(decoded, entry.model).toEqual(
        JSON.parse(readFileSync(new URL(file, mechDir), "utf8")),
      );
    }
    const mapDir = new URL("../data/maps/", import.meta.url);
    const mapFiles = readdirSync(mapDir).filter((f) => f.endsWith(".json"));
    expect(mapFiles.length).toBe(MANIFEST.maps.length);
    for (const entry of MANIFEST.maps) {
      const decoded = decodeMapLine(LINES[entry.line]!);
      const file = mapFiles.find(
        (f) => JSON.parse(readFileSync(new URL(f, mapDir), "utf8")).name === entry.name,
      )!;
      expect(decoded, entry.name).toEqual(JSON.parse(readFileSync(new URL(file, mapDir), "utf8")));
    }
  });

  it("finds entries (mechs case-insensitively) and misses unknown names", () => {
    const first = MANIFEST.mechs[0]!;
    expect(findMechEntry(MANIFEST, first.model.toLowerCase())?.model).toBe(first.model);
    expect(findMechEntry(MANIFEST, "no-such-mech")).toBeUndefined();
    const map = MANIFEST.maps[0]!;
    expect(findMapEntry(MANIFEST, map.name)?.name).toBe(map.name);
    expect(findMapEntry(MANIFEST, "no-such-map")).toBeUndefined();
  });

  it("rejects malformed manifests", () => {
    expect(() => parseCatalogManifest(null)).toThrow();
    expect(() => parseCatalogManifest({ v: 2, mechs: [], maps: [] })).toThrow();
    expect(() => parseCatalogManifest({ v: 1, mechs: [], maps: [] })).not.toThrow();
    expect(() => parseCatalogManifest({ v: 1, mechs: [{ m: "X" }], maps: [] })).toThrow();
    expect(() =>
      parseCatalogManifest({
        v: 1,
        mechs: [
          { m: "X", n: "Y", b: 1, t: 50, l: 2 },
          { m: "x", n: "Y", b: 2, t: 50, l: 3 },
        ],
        maps: [],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseCatalogManifest({
        v: 1,
        mechs: [{ m: "X", n: "Y", b: 1, t: 50, c: "W", l: 2 }],
        maps: [{ n: "M", w: 1, h: 1, l: 2 }],
      }),
    ).not.toThrow();
  });

  it("rejects malformed lines", () => {
    const id = { model: "X", name: "Y", techBase: "Inner Sphere", tonnage: 50 };
    expect(() => decodeMechLine("not json", id)).toThrow();
    expect(() => decodeMechLine("[1,2]", id)).toThrow();
    expect(() => decodeMechLine('{"w":1}', id)).toThrow();
    expect(() => decodeMechLine('{"v":2,"w":1}', id)).toThrow();
    expect(() => decodeMechLine('{"v":1,"w":1}', id)).toThrow(/running/);
    expect(() => decodeMapLine("not json")).toThrow();
    expect(() => decodeMapLine('{"v":1,"m":"X"}')).toThrow();
  });
});

describe("catalog registration", () => {
  it("decodes the identical model the registry already holds", () => {
    // Setup registered every sheet, so re-registering a decoded sheet must
    // throw as a duplicate — proving the lazy path decodes the same model.
    const entry = findMechEntry(MANIFEST, "as7-d")!;
    expect(() => registerMech(decodeMechLine(mechLine(entry), entry, STRINGS))).toThrow(
      /duplicate/i,
    );
    expect(mechDefFor({ model: "AS7-D" }).name).toBe("Atlas");
  });

  it("registers one decoded map on demand", () => {
    const entry = findMapEntry(MANIFEST, "quickstart")!;
    expect(() => registerMap(decodeMapLine(LINES[entry.line]!))).toThrow(/duplicate/i);
  });

  it("splits the Clan name out of the MTF line-2 parens", () => {
    const entry = findMechEntry(MANIFEST, "tw-prime")!;
    const def = decodeMechLine(mechLine(entry), entry, STRINGS);
    expect(def.name).toBe("Mad Cat");
    expect(def.clanName).toBe("Timber Wolf");
    const warhawkEntry = findMechEntry(MANIFEST, "whk-prime")!;
    const warhawk = decodeMechLine(mechLine(warhawkEntry), warhawkEntry, STRINGS);
    expect(warhawk.name).toBe("Masakari");
    expect(warhawk.clanName).toBe("Warhawk");
  });

  it("leaves clanName undefined when the parens are absent, even for Clan sheets", () => {
    const entry = findMechEntry(MANIFEST, "mc-mkii-2")!;
    expect(decodeMechLine(mechLine(entry), entry, STRINGS).clanName).toBeUndefined();
  });

  it("keeps identity single-sourced: wire lines carry no model/name/techBase/tonnage", () => {
    for (const entry of MANIFEST.mechs) {
      const wire = JSON.parse(mechLine(entry)) as Record<string, unknown>;
      for (const key of ["m", "n", "t", "b", "model", "name", "tonnage", "techBase"]) {
        expect(wire, `${entry.model}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("stays O(roster): one ensure registers exactly one sheet", () => {
    // True lazy path (setup pre-registers everything, so start from empty
    // and restore afterwards — keeps this file order-independent).
    purgeMechDefs();
    try {
      expect(allMechDefs()).toHaveLength(0);
      const def = ensureMechRegistered("hbk-4g");
      expect(def?.model).toBe("HBK-4G");
      expect(allMechDefs()).toHaveLength(1);
      expect(ensureMechRegistered("HBK-4G")).toBe(def);
      expect(allMechDefs()).toHaveLength(1);
      expect(ensureMechRegistered("no-such-mech")).toBeUndefined();
      expect(ensureMapRegistered("no-such-map")).toBeUndefined();
    } finally {
      registerAllCatalog();
    }
    expect(allMechDefs().length).toBe(MANIFEST.mechs.length);
    expect(allMapDefs().length).toBe(MANIFEST.maps.length);
  });
});
