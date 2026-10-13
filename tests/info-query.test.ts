import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerMech } from "../dist/data/mech.schema.js";
import { parseMtf } from "../scripts/mtf.mjs";
import type { MechManifestEntry } from "../src/data/catalog";
import type { MechDef } from "../src/data/index";
import { WEAPON_DATA } from "../src/data/weapons.data";
import type { Chunk } from "../web/terminal/chunk";
import { displayModel } from "../web/terminal/misc";
import {
  closestNames,
  MECH_FILTER_KEYS,
  parseNumberRange,
  parseQuery,
  ROW_CAP,
  selectMechs,
  selectWeapons,
  WEAPON_FILTER_KEYS,
  weaponMaxDamage,
  weaponTech,
} from "../web/terminal/query";
import { newSession } from "../web/terminal/session";
import { infoMechChunk } from "../web/terminal/session.common";
import { infoMechQuery, infoWeaponQuery } from "../web/terminal/table";
import { chunkText, execute } from "./helpers";

function mech(model: string, name: string, tonnage: number, techBase = "Inner Sphere") {
  return { model, name, tonnage, techBase, line: 0 } satisfies MechManifestEntry;
}

/** `chassis` chassis × `variants` models each, all at one tonnage. */
function roster(
  chassis: number,
  variants: number,
  tonnage: number,
  prefix = "C",
): MechManifestEntry[] {
  const out: MechManifestEntry[] = [];
  for (let c = 0; c < chassis; c++) {
    for (let v = 0; v < variants; v++) {
      out.push(mech(`${prefix}${c}-${v}`, `${prefix}hassis ${c}`, tonnage));
    }
  }
  return out;
}

function listChunks(args: string, entries: readonly MechManifestEntry[]): Chunk[] {
  const res = infoMechQuery(
    args.split(" ").filter((a) => a !== ""),
    entries,
  );
  if (res.kind !== "list") throw new Error(`expected a list, got sheet ${res.model}`);
  return res.chunks;
}

const SAMPLE = [
  mech("HBK-4G", "Hunchback", 50),
  mech("HBK-4P", "Hunchback", 50),
  mech("TBR-Prime", "Mad Cat", 75, "Clan"),
  mech("AS7-D", "Atlas", 100),
  mech("LCT-1V", "Locust", 20),
];
(SAMPLE[2] as { clanName?: string }).clanName = "Timber Wolf";

describe("parseQuery", () => {
  it("splits words, filters and the ! flag", () => {
    const q = parseQuery(["Mad", "class:H", "cat", "!", "TON:70"], MECH_FILTER_KEYS);
    expect(q.text).toBe("Mad cat");
    expect([...q.filters]).toEqual([
      ["class", "H"],
      ["ton", "70"],
    ]);
    expect(q.force).toBe(true);
  });

  it("rejects unknown keys and empty values", () => {
    expect(() => parseQuery(["era:sw"], MECH_FILTER_KEYS)).toThrow(/era:/);
    expect(() => parseQuery(["ton:"], MECH_FILTER_KEYS)).toThrow(/ton:/);
    expect(() => parseQuery(["cat:energy"], MECH_FILTER_KEYS)).toThrow(/cat:/);
    expect(parseQuery(["cat:energy"], WEAPON_FILTER_KEYS).filters.get("cat")).toBe("energy");
  });
});

describe("parseNumberRange", () => {
  it.each([
    ["70", 70, true],
    ["70", 75, false],
    ["60-75", 60, true],
    ["75-60", 75, true],
    ["60-75", 80, false],
    [">=80", 80, true],
    [">80", 80, false],
    ["<=3", 3, true],
    ["<3", 3, false],
  ])("%s matches %d: %s", (spec, n, want) => {
    expect(parseNumberRange(spec)?.(n)).toBe(want);
  });

  it("returns null for junk", () => {
    expect(parseNumberRange("abc")).toBeNull();
    expect(parseNumberRange("=>3")).toBeNull();
  });
});

describe("selectMechs", () => {
  const q = (...args: string[]) => parseQuery(args, MECH_FILTER_KEYS);
  const models = (...args: string[]) => selectMechs(SAMPLE, q(...args)).map((m) => m.model);

  it("matches text against model, chassis and Clan name", () => {
    expect(models("hbk")).toEqual(["HBK-4G", "HBK-4P"]);
    expect(models("timber")).toEqual(["TBR-Prime"]);
    expect(models("mad", "cat")).toEqual(["TBR-Prime"]);
  });

  it("filters by class, tonnage and tech", () => {
    expect(models("class:a,l")).toEqual(["LCT-1V", "AS7-D"]);
    expect(models("class:heavy")).toEqual(["TBR-Prime"]);
    expect(models("ton:50-75", "tech:is")).toEqual(["HBK-4G", "HBK-4P"]);
    expect(models("tech:clan")).toEqual(["TBR-Prime"]);
    expect(() => models("class:x")).toThrow(/class:x/);
    expect(() => models("ton:heavy")).toThrow(/ton:heavy/);
  });

  it("sorts by tonnage by default and honors sort:", () => {
    expect(models()).toEqual(["LCT-1V", "HBK-4G", "HBK-4P", "TBR-Prime", "AS7-D"]);
    expect(models("sort:-ton")[0]).toBe("AS7-D");
    expect(models("sort:name")).toEqual(["AS7-D", "HBK-4G", "HBK-4P", "LCT-1V", "TBR-Prime"]);
    expect(() => models("sort:bv")).toThrow(/sort:bv/);
  });
});

describe("info mech tiers", () => {
  it("opens the sheet for an exact model or a single match", () => {
    expect(infoMechQuery(["hbk-4g"], SAMPLE)).toEqual({
      kind: "sheet",
      model: "HBK-4G",
      note: null,
    });
    expect(infoMechQuery(["atlas"], SAMPLE)).toEqual({
      kind: "sheet",
      model: "AS7-D",
      note: "'atlas' matched only one 'Mech: AS7-D",
    });
    expect(infoMechQuery(["hbk-4g", "tech:is"], SAMPLE)).toMatchObject({
      note: "'hbk-4g tech:is' matched only one 'Mech: HBK-4G",
    });
    expect(infoMechQuery(["atlas", "!"], SAMPLE).kind).toBe("list");
  });

  it("prints a table up to the row cap", () => {
    const entries = roster(4, 5, 50);
    expect(entries).toHaveLength(ROW_CAP);
    const chunks = listChunks("", entries);
    expect(chunks.map((c) => c.kind)).toEqual(["lines", "columns"]);
    expect(chunkText(chunks[0]!)[0]).toBe("20 'Mechs, 4 chassis");
  });

  it("groups into collapsible chassis rows past the row cap", () => {
    const chunks = listChunks("", roster(ROW_CAP, 2, 50));
    const rows = chunks.filter((c) => c.kind === "collapsible");
    expect(rows).toHaveLength(ROW_CAP);
    expect(rows[0]!.kind === "collapsible" && rows[0]!.summary).toMatch(
      /^50t Chassis 0\s+2 {2}C0-0 C0-1$/,
    );
    expect(chunkText(chunks.at(-1)!)[0]).toMatch(/add ! for the full list/);
  });

  it("shortens long variant lists on a chassis row", () => {
    const chunks = listChunks("", roster(3, 8, 50));
    const row = chunks.find((c) => c.kind === "collapsible");
    expect(row?.kind === "collapsible" && row.summary).toMatch(/C0-5 …$/);
  });

  it("falls back to counts by class, then by tonnage, past the chassis cap", () => {
    const mixed = [...roster(15, 2, 30, "L"), ...roster(15, 2, 70, "H")];
    const byClass = listChunks("", mixed).flatMap(chunkText).join("\n");
    expect(byClass).toMatch(/│Light\s+│30t\s+│30\s+│15\s+│/);
    expect(byClass).toMatch(/│Heavy\s+│70t\s+│30\s+│15\s+│/);

    const heavy = [...roster(15, 2, 65, "A"), ...roster(15, 2, 70, "B")];
    const byTon = listChunks("class:heavy", heavy).flatMap(chunkText).join("\n");
    expect(byTon).toMatch(/│65t\s+│30\s+│15\s+│/);
    expect(byTon).toMatch(/│70t\s+│30\s+│15\s+│/);
  });

  it("caps chassis rows when one tonnage still has too many chassis", () => {
    const chunks = listChunks("", roster(ROW_CAP + 5, 1, 50));
    expect(chunks.filter((c) => c.kind === "collapsible")).toHaveLength(ROW_CAP);
    expect(chunks.flatMap(chunkText).join("\n")).toContain("… 5 more chassis");
  });

  it("prints every row with !", () => {
    const chunks = listChunks("!", roster(ROW_CAP, 3, 50));
    expect(chunks.map((c) => c.kind)).toEqual(["lines", "columns"]);
    expect(chunkText(chunks[1]!).filter((l) => l.startsWith("│C"))).toHaveLength(ROW_CAP * 3);
  });

  it("suggests close models for an unknown one", () => {
    expect(() => infoMechQuery(["hbk-4x"], SAMPLE)).toThrow(
      "Unknown 'Mech model: hbk-4x; closest: HBK-4G, HBK-4P",
    );
    expect(() => infoMechQuery(["zzzz"], SAMPLE)).toThrow("(try 'info mech')");
    expect(() => infoMechQuery(["class:l", "ton:50"], SAMPLE)).toThrow(
      "No 'Mech matches: class:l ton:50",
    );
  });
});

describe("weapon queries", () => {
  const q = (...args: string[]) => parseQuery(args, WEAPON_FILTER_KEYS);
  const names = (...args: string[]) => selectWeapons(WEAPON_DATA, q(...args)).map((w) => w.name);
  const text = (args: string) =>
    chunkText(infoWeaponQuery(args.split(" ").filter((a) => a !== "")));

  it("infers Clan tech from the CL prefix", () => {
    expect(weaponTech(WEAPON_DATA.find((w) => w.name === "CL ER PPC")!)).toBe("clan");
    expect(weaponTech(WEAPON_DATA.find((w) => w.name === "ER PPC")!)).toBe("is");
    expect(names("ppc", "tech:clan")).toEqual(["CL ER PPC"]);
  });

  it("filters by category, heat, long range and best-case damage", () => {
    expect(names("cat:en", "tech:is", "heat:<=1")).toEqual(["Small Laser"]);
    expect(() => names("cat:e")).toThrow(/cat:e/);
    expect(names("lrm 20", "tech:is", "dmg:20")).toEqual(["LRM 20"]);
    expect(weaponMaxDamage(WEAPON_DATA.find((w) => w.name === "SRM 6")!)).toBe(12);
    expect(names("range:>=30", "cat:energy")).toEqual([]);
  });

  it("shows detail for an exact name or a single match", () => {
    expect(text("medium laser")[0]).toBe("Medium Laser [Energy]");
    expect(text("MEDIUM LASER")[0]).toBe("Medium Laser [Energy]");
    expect(text("snub").slice(0, 2)).toEqual([
      "'snub' matched only one weapon: Snub-Nose PPC",
      "Snub-Nose PPC [Energy]",
    ]);
  });

  it("prints stat lines up to the cap and names only past it", () => {
    const few = text("cat:energy tech:is heat:<=3");
    expect(few[0]).toBe("5 weapons match: cat:energy tech:is heat:<=3");
    expect(few).toContain("[Energy]");
    expect(few.some((l) => /^ {2}Medium Laser\s+S3 \/ M6 \/ L9/.test(l))).toBe(true);

    const many = text("laser");
    expect(many[0]).toBe("23 weapons match: laser");
    expect(many[1]).toMatch(/^\[Energy\] 21: Binary Laser Cannon, /);
    expect(many.at(-1)).toMatch(/add ! for every stat line/);
    expect(text("laser !").length).toBeGreaterThan(23);
  });

  it("suggests close names for an unknown weapon", () => {
    expect(() => text("medum laser")).toThrow(/closest: Medium Laser/);
    expect(() => text("cat:missile heat:>=99")).toThrow("No weapon matches: cat:missile heat:>=99");
  });
});

describe("closestNames", () => {
  it("prefers prefixes, then substrings, then edit distance", () => {
    expect(closestNames("hbk", ["XHBK-1", "HBK-4G", "ABC-1"])).toEqual(["HBK-4G", "XHBK-1"]);
    expect(closestNames("as7-x", ["AS7-D", "LCT-1V"])).toEqual(["AS7-D"]);
    expect(closestNames("zzzz", ["AS7-D"])).toEqual([]);
  });
});

describe("callsign display", () => {
  it("renders the callsign suffix only when present", () => {
    expect(displayModel({ model: "HBK-4G" })).toBe("HBK-4G");
    expect(displayModel({ model: "AS7-WGS", callsign: "Samsonov" })).toBe("AS7-WGS (Samsonov)");
  });

  it("matches callsign text in selectMechs", () => {
    const entries = [...SAMPLE, { ...mech("AS7-WGS", "Atlas", 100), callsign: "Samsonov" }];
    const models = selectMechs(entries, parseQuery(["samsonov"], MECH_FILTER_KEYS)).map(
      (m) => m.model,
    );
    expect(models).toEqual(["AS7-WGS"]);
  });

  it("shows the callsign in the mech table Model column", () => {
    const entries = [
      mech("HBK-4G", "Hunchback", 50),
      { ...mech("AS7-WGS", "Atlas", 100), callsign: "Samsonov" },
    ];
    const text = listChunks("!", entries).flatMap(chunkText).join("\n");
    expect(text).toContain("AS7-WGS (Samsonov)");
    expect(text).not.toContain("HBK-4G (");
  });

  it("shows the callsign on info and sheet headlines but not in status", () => {
    const file = "docs/mtf/sw/mtf/Atlas AS7-WGS Samsonov.mtf";
    const { def, errors } = parseMtf(readFileSync(file, "utf8"), file);
    expect(errors).toEqual([]);
    registerMech(def as unknown as MechDef);
    const s = newSession(1);
    execute(s, "map quickstart");
    expect(execute(s, "add sammy AS7-WGS 9 9 n")[0]).toContain("placed");
    execute(s, "add hunchy HBK-4G 9 8 s");
    expect(execute(s, "status").join("\n")).not.toContain("Samsonov");
    expect(infoMechChunk("AS7-WGS").flatMap(chunkText).join("\n")).toContain(
      "Atlas AS7-WGS (Samsonov)",
    );
    execute(s, "start");
    expect(execute(s, "sheet sammy").join("\n")).toContain("model: Atlas AS7-WGS (Samsonov)");
  });
});

describe("info commands in the CLI", () => {
  it("routes info mech / info weapon queries", () => {
    const s = newSession(1);
    expect(execute(s, "info mech mad")[0]).toBe("2 'Mechs, 2 chassis match: mad");
    expect(execute(s, "info mech HBK-4g")[0]).not.toContain("matched only one");
    const atlas = execute(s, "info mech atlas");
    expect(atlas[0]).toBe("'atlas' matched only one 'Mech: AS7-D");
    expect(atlas.join("\n")).toContain("Atlas AS7-D");
    expect(execute(s, "info mech hbk-4x")[0]).toBe(
      "error: Unknown 'Mech model: hbk-4x; closest: HBK-4G",
    );
    expect(execute(s, "info mech era:sw")[0]).toMatch(/^error: Unknown filter 'era:'/);
    expect(execute(s, "info weapon")[0]).toBe("114 weapons");
    expect(execute(s, "add a hbk-4x 1 1")[0]).toContain("closest: HBK-4G");
  });

  it("documents the query grammar in help info", () => {
    const s = newSession(1);
    const help = execute(s, "help info");
    expect(help[0]).toBe("usage: info mech [model | text] [key:value ...] [!]");
    expect(help.join("\n")).toContain("class:l|m|h|a  ton:70|60-75|>=80  tech:is|clan");
    expect(help.join("\n")).toContain("cat:ballistic|energy|missile|equipment");
  });
});
