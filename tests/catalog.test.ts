/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeMapLine,
  decodeMechLine,
  findMapEntry,
  findMechEntry,
  parseCatalogManifest,
  parseCatalogStrings,
  registerAllCatalog,
} from "../src/data/catalog";
import {
  appendCatalog,
  type CatalogManifest,
  type CatalogStringTable,
  catalogMaps,
  catalogMechs,
  ensureMapRegistered,
  ensureMechRegistered,
  loadCatalog,
  mechDefFor,
  registeredMapDefs,
  registeredMechDefs,
  registerMap,
  registerMech,
  weightClassForTonnage,
} from "../src/data/index";
import { resolveStringRef } from "../src/data/mech.codec";
import { purgeMechDefs } from "../src/data/mech.schema";
import { decodeRelaxed, encodeRelaxed } from "../src/data/relaxed-json";

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
      const src = decodeMapLine(LINES[entry.line]!, entry);
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
      const decoded = decodeMapLine(LINES[entry.line]!, entry);
      const file = mapFiles.find(
        (f) => JSON.parse(readFileSync(new URL(f, mapDir), "utf8")).name === entry.name,
      )!;
      expect(decoded, entry.name).toEqual(JSON.parse(readFileSync(new URL(file, mapDir), "utf8")));
    }
  });

  it("finds entries (mechs case-insensitively) and misses unknown names", () => {
    const first = MANIFEST.mechs[0]!;
    expect(findMechEntry(first.model.toLowerCase())?.model).toBe(first.model);
    expect(findMechEntry("no-such-mech")).toBeUndefined();
    const map = MANIFEST.maps[0]!;
    expect(findMapEntry(map.name)?.name).toBe(map.name);
    expect(findMapEntry("no-such-map")).toBeUndefined();
  });

  it("rejects malformed manifests", () => {
    expect(() => parseCatalogManifest(null)).toThrow();
    expect(() => parseCatalogManifest({ v: 2, mechs: [], maps: [] })).toThrow();
    expect(() => parseCatalogManifest({ v: 1, mechs: [], maps: [] })).not.toThrow();
    expect(() => parseCatalogManifest({ v: 1, mechs: [{ m: "X" }], maps: [] })).toThrow();
    expect(() =>
      parseCatalogManifest(
        {
          v: 1,
          mechs: [
            { m: "X", n: 0, b: 1, t: 50, i: 3025, l: 2 },
            { m: "x", n: 0, b: 2, t: 50, i: 3025, l: 3 },
          ],
          maps: [],
        },
        ["Y"],
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseCatalogManifest(
        {
          v: 1,
          mechs: [{ m: "X", n: 0, b: 1, t: 50, i: 3025, c: "W", l: 2 }],
          maps: [{ n: "M", w: 1, h: 1, l: 2 }],
        },
        ["Y"],
      ),
    ).not.toThrow();
  });

  it("rejects malformed lines", () => {
    const MAP_ID = { name: "M", width: 1, height: 1 };
    const id = { model: "X", name: "Y", techBase: "Inner Sphere", tonnage: 50, intro: 3025 };
    expect(() => decodeMechLine("not json", id)).toThrow();
    expect(() => decodeMechLine("[1,2]", id)).toThrow();
    expect(() => decodeMechLine('{"w":1}', id)).toThrow();
    expect(() => decodeMechLine('{"v":2,"w":1}', id)).toThrow();
    expect(() => decodeMechLine('{"v":1,"w":1}', id)).toThrow(/running/);
    expect(() => decodeMapLine("not json", MAP_ID)).toThrow();
    expect(resolveStringRef(["A", "B"], 1, "x")).toBe("B");
    expect(() => resolveStringRef(["A"], "$0", "x")).toThrow(/bad x reference/);
    expect(() => resolveStringRef(["A"], 5, "x")).toThrow(/out of range/);
    expect(() => decodeMapLine('{"v":1}', MAP_ID)).toThrow();
  });
});

describe("sw season pack", () => {
  const SW_TEXT = readFileSync(new URL("../docs/mtf/sw/sw.jsonl", import.meta.url), "utf8");
  const SW_STRINGS: CatalogStringTable = parseCatalogStrings(JSON.parse(SW_TEXT.split("\n")[0]!));
  const SW_LINES = SW_TEXT.split("\n");
  const warnings: string[] = [];
  const SW: CatalogManifest = appendCatalog(SW_TEXT, "sw", (message) => {
    warnings.push(message);
  });

  it("loads beside base with its own string table and pack tags", () => {
    expect(SW.version).toBe(1);
    expect(SW.mechs.length).toBe(391);
    expect(SW.maps).toHaveLength(0);
    for (const entry of SW.mechs) {
      expect(entry.pack).toBe("sw");
    }
    for (const entry of MANIFEST.mechs) {
      expect(entry.pack).toBe("base");
    }
    // Separate tables: the SW chassis names resolve through the SW table.
    expect(SW_STRINGS).not.toEqual(STRINGS);
    const first = SW.mechs[0]!;
    const def = decodeMechLine(SW_LINES[first.line]!, first, SW_STRINGS);
    expect(def.model).toBe(first.model);
    expect(def.name).toBe(first.name);
  });

  it("lets base lose cross-pack duplicates without a warning, ignoring the latter", () => {
    expect(warnings.length).toBe(0);
    // Overlap models resolve to the sw sheet (e.g. HBK-4G exists in both).
    expect(findMechEntry("hbk-4g")?.pack).toBe("sw");
    expect(findMechEntry("as7-d")?.pack).toBe("sw");
    expect(findMechEntry("enf-4r")?.pack).toBe("sw");
    // SW-only models resolve to sw.
    expect(findMechEntry("aem-01")?.pack).toBe("sw");
    // Split-location sheets (King Crab arm AC/20s) are packed too.
    expect(findMechEntry("kgc-000")?.pack).toBe("sw");
  });

  it("round-trips every sw sheet through its own wire exactly", () => {
    const swDir = new URL("../docs/mtf/sw/json/", import.meta.url);
    const swFiles = readdirSync(swDir).filter((f) => f.endsWith(".json"));
    expect(swFiles).toContain("kgc-000.json");
    expect(swFiles.length).toBe(SW.mechs.length);
    for (const entry of SW.mechs) {
      const decoded = decodeMechLine(SW_LINES[entry.line]!, entry, SW_STRINGS);
      const file = swFiles.find((f) => f.toLowerCase() === `${entry.model.toLowerCase()}.json`)!;
      expect(decoded, entry.model).toEqual(JSON.parse(readFileSync(new URL(file, swDir), "utf8")));
    }
  });
});

describe("catalog registration", () => {
  it("decodes the identical model the registry already holds", () => {
    // Setup registered every sheet, so re-registering a decoded sheet must
    // throw as a duplicate — proving the lazy path decodes the same model.
    // Sourced from the base manifest: AS7-D exists in both packs and the
    // lookup winner is the sw entry (whose line number is sw-file-local).
    const entry = MANIFEST.mechs.find((m) => m.model === "AS7-D")!;
    expect(() => registerMech(decodeMechLine(mechLine(entry), entry, STRINGS))).toThrow(
      /duplicate/i,
    );
    expect(mechDefFor({ model: "AS7-D" }).name).toBe("Atlas");
  });

  it("registers one decoded map on demand", () => {
    const entry = findMapEntry("quickstart")!;
    expect(() => registerMap(decodeMapLine(LINES[entry.line]!, entry))).toThrow(/duplicate/i);
  });

  it("splits the Clan name out of the MTF line-2 parens", () => {
    const entry = findMechEntry("tbr-prime")!;
    const def = decodeMechLine(mechLine(entry), entry, STRINGS);
    expect(def.name).toBe("Mad Cat");
    expect(def.clanName).toBe("Timber Wolf");
    const warhawkEntry = findMechEntry("whk-prime")!;
    const warhawk = decodeMechLine(mechLine(warhawkEntry), warhawkEntry, STRINGS);
    expect(warhawk.name).toBe("Masakari");
    expect(warhawk.clanName).toBe("Warhawk");
  });

  it("leaves clanName undefined when the parens are absent, even for Clan sheets", () => {
    const entry = findMechEntry("mc-mkii-2")!;
    expect(decodeMechLine(mechLine(entry), entry, STRINGS).clanName).toBeUndefined();
  });

  it("round-trips an optional callsign through the manifest identity", () => {
    const entry = findMechEntry("tbr-prime")!;
    const wire = mechLine(entry);
    const id = { ...entry, callsign: "Ross" };
    expect(decodeMechLine(wire, id, STRINGS).callsign).toBe("Ross");
    expect(decodeMechLine(wire, entry, STRINGS).callsign).toBeUndefined();
    const manifest = parseCatalogManifest(
      {
        v: 1,
        mechs: [{ m: "X", n: 0, b: 1, t: 50, i: 3025, k: "Ross", l: 2 }],
        maps: [],
      },
      ["Y"],
    );
    expect(manifest.mechs[0]!.callsign).toBe("Ross");
    expect(manifest.mechs[0]!.intro).toBe(3025);
    expect(() =>
      parseCatalogManifest(
        { v: 1, mechs: [{ m: "X", n: 0, b: 1, t: 50, i: 3025, k: "", l: 2 }], maps: [] },
        ["Y"],
      ),
    ).toThrow(/callsign/);
    expect(() =>
      parseCatalogManifest({ v: 1, mechs: [{ m: "X", n: 0, b: 1, t: 50, l: 2 }], maps: [] }, ["Y"]),
    ).toThrow(/intro/);
  });

  it("keeps identity single-sourced: wire lines carry no model/name/techBase/tonnage", () => {
    for (const entry of MANIFEST.mechs) {
      const wire = decodeRelaxed(mechLine(entry)) as Record<string, unknown>;
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
      expect(registeredMechDefs()).toHaveLength(0);
      const def = ensureMechRegistered("hbk-4g");
      expect(def?.model).toBe("HBK-4G");
      expect(registeredMechDefs()).toHaveLength(1);
      expect(ensureMechRegistered("HBK-4G")).toBe(def);
      expect(registeredMechDefs()).toHaveLength(1);
      expect(ensureMechRegistered("no-such-mech")).toBeUndefined();
      expect(ensureMapRegistered("no-such-map")).toBeUndefined();
    } finally {
      registerAllCatalog();
    }
    expect(registeredMechDefs().length).toBe(catalogMechs().length);
    expect(registeredMapDefs().length).toBe(catalogMaps().length);
  });
});

describe("relaxed json", () => {
  it("drops key quotes and still parses plain JSON", () => {
    expect(encodeRelaxed({ a: 1, b: "asdf" })).toBe('{a:1,b:"asdf"}');
    expect(encodeRelaxed({ "a-b": [1, { c: null }], d: true })).toBe('{"a-b":[1,{c:null}],d:true}');
    expect(decodeRelaxed('{a:1,b:"asdf"}')).toEqual({ a: 1, b: "asdf" });
    expect(decodeRelaxed(' { "a" : [ 1 , -2.5e1 ] , b : { } } ')).toEqual({ a: [1, -25], b: {} });
    expect(decodeRelaxed('{s:"x:\\"y\\",z"}')).toEqual({ s: 'x:"y",z' });
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "{a:}", "{a:1", "[1,", '{a:"x}', "{1:2}", "{a:1} x", "nope"]) {
      expect(() => decodeRelaxed(bad), bad).toThrow(/relaxed JSON/);
    }
  });

  it("stores every mech and map line as relaxed JSON", () => {
    for (const entry of [...MANIFEST.mechs, ...MANIFEST.maps]) {
      const line = LINES[entry.line]!;
      const value = decodeRelaxed(line);
      expect(encodeRelaxed(value)).toBe(line);
      expect(line.length).toBeLessThan(JSON.stringify(value).length);
      expect(line).not.toMatch(/"[A-Za-z]+":/);
    }
  });
});
