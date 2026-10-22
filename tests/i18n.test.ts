import { beforeEach, describe, expect, it } from "vitest";
import {
  bestFireTarget,
  isNominal,
  isUnitAvailable,
  isUnitRemoved,
  mechDefFor,
  reachableLandings,
  suggestFireTargets,
} from "../src/index";
import { i18nIn, normalizeLocale } from "../web/terminal/i18n/index";
import {
  commitAttack,
  commitMovement,
  configLocale,
  declareMovementMode,
  newSession,
  placeLanding,
  queueWeaponAttacks,
  setConfigLocale,
} from "../web/terminal/session";
import { bearing, currentActor, execute } from "./helpers";

/** Drive a started battle until it is over using minimal legal actions. */
function autoPlay(s: ReturnType<typeof newSession>): void {
  // A unit that cannot bear on its enemy turns toward it next activation;
  // without this two face-away 'Mechs passFire forever.
  let faceEnemy = false;
  for (let i = 0; i < 500 && s.state === "battle"; i++) {
    const st = s.battle!;
    const actorId = currentActor(s)!.id;
    const ids = Object.values(st.units)
      .filter((u) => isUnitAvailable(u))
      .map((u) => u.id);
    const enemy = ids.find((id) => id !== actorId)!;
    if (st.phase === "movement") {
      if (isNominal(st.units[actorId]!)) {
        if (st.units[actorId]!.prone) {
          try {
            declareMovementMode(s, "standup", "walk");
          } catch {
            // Cannot afford the stand (wrecked legs/heat): hold prone.
            declareMovementMode(s, "pronestill");
          }
        } else {
          try {
            declareMovementMode(s, "walk");
          } catch {
            declareMovementMode(s, "standStill");
          }
          if (faceEnemy) {
            faceEnemy = false;
            const me = st.units[actorId]!;
            const foe = st.units[enemy];
            if (foe !== undefined && !isUnitRemoved(foe)) {
              const want = bearing(me.position, foe.position);
              if (want !== null && want !== me.facing) {
                // Turn in place via a same-hex landing; a missing landing
                // (or place error) falls back to standing in place.
                try {
                  const def = mechDefFor(me);
                  const landings = reachableLandings({ ...me.position }, me.facing, {
                    mode: "walk",
                    walking: def.walking,
                    running: def.running,
                    jumping: def.jumping,
                    prone: false,
                    grid: st,
                    team: me.team,
                    occupantTeam: (hex) => {
                      for (const u of Object.values(st.units)) {
                        if (isUnitRemoved(u)) continue;
                        if (u.position.col === hex.col && u.position.row === hex.row) return u.team;
                      }
                      return undefined;
                    },
                  });
                  const turn = landings.find(
                    (l) =>
                      l.hex.col === me.position.col &&
                      l.hex.row === me.position.row &&
                      l.facing === want,
                  );
                  if (turn !== undefined) placeLanding(s, turn);
                } catch {
                  // fall through to standing in place
                }
              }
            }
          }
        }
      }
      commitMovement(s);
    } else {
      const unit = st.units[actorId]!;
      const sugg = suggestFireTargets(st, unit.id);
      const target = sugg.targets.find((t) => t.targetId === enemy) ?? bestFireTarget(sugg);
      const weapons =
        (target?.weaponsIfPropLeft.length ?? 0) >= (target?.weaponsIfPropRight.length ?? 0)
          ? (target?.weaponsIfPropLeft ?? [])
          : (target?.weaponsIfPropRight ?? []);
      const weaponIndexList = weapons
        .filter((w) => !unit.jammedWeapons.includes(w.weaponIndex))
        .map((w) => w.weaponIndex);
      if (weaponIndexList.length === 0) {
        faceEnemy = true;
      } else {
        queueWeaponAttacks(s, enemy, weaponIndexList);
      }
      commitAttack(s);
    }
  }
  if (s.state !== "over") throw new Error("battle did not finish");
}

describe("i18n catalogs", () => {
  it("interpolates {param} placeholders", () => {
    expect(i18nIn("en", "ok.mapLoaded", { name: "beginner", w: 15, h: 16 })).toBe(
      "map beginner: 15x16",
    );
    expect(i18nIn("ko", "lang.set", { locale: "ko" })).toBe("언어가 ko(으)로 설정되었습니다");
  });

  it("accepts kr as an alias of ko", () => {
    expect(normalizeLocale("kr")).toBe("ko");
    expect(normalizeLocale("KR")).toBe("ko");
    expect(normalizeLocale("ko")).toBe("ko");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("xx")).toBeNull();
  });

  it("leaves unknown keys out of interpolation when params are absent", () => {
    expect(i18nIn("en", "ok.cancelled", {})).toBe("cancelled");
  });
});

describe("lang command", () => {
  beforeEach(() => {
    setConfigLocale("en");
  });

  it("defaults to English and lists available locales", () => {
    const s = newSession(7);
    expect(configLocale()).toBe("en");
    expect(execute(s, "lang")).toEqual(["language: en", "available: en, ko"]);
  });

  it("switches output language for subsequent commands", () => {
    const s = newSession(7);
    expect(execute(s, "lang ko")).toEqual(["언어가 ko(으)로 설정되었습니다"]);
    expect(configLocale()).toBe("ko");
    expect(execute(s, "status")[0]).toBe("맵: (없음)");
    expect(execute(s, "help")[0]).toBe(i18nIn("ko", "hint.setup").split("\n")[0]);
  });

  it("accepts kr as an alias of ko", () => {
    const s = newSession(7);
    expect(execute(s, "lang kr")).toEqual(["언어가 ko(으)로 설정되었습니다"]);
    expect(configLocale()).toBe("ko");
  });

  it("rejects unknown locale codes with a localized error", () => {
    const s = newSession(7);
    execute(s, "lang ko");
    expect(execute(s, "lang xx")).toEqual([`오류: 알 수 없는 언어 'xx' (사용 가능: en, ko)`]);
  });

  it("preserves the locale across reset and rematch", () => {
    const s = newSession(7);
    execute(s, "lang ko");
    execute(s, "reset");
    expect(configLocale()).toBe("ko");

    execute(s, "map beginner");
    execute(s, "add a1 HBK-4G 2 2 s");
    execute(s, "add b1 HBK-4G 2 4 n");
    execute(s, "start");
    autoPlay(s);
    expect(execute(s, "rematch")[0]).toBe("=== 재경기 시작 ===");
    expect(configLocale()).toBe("ko");
  });
});

describe("localized output smoke test", () => {
  beforeEach(() => {
    setConfigLocale("en");
  });

  it("renders board placeholder and errors in Korean after switching", () => {
    const s = newSession(7);
    execute(s, "lang ko");
    expect(execute(s, "board")).toEqual([i18nIn("ko", "board.noMap")]);
    expect(execute(s, "bogus")).toEqual([`오류: 알 수 없는 명령 'bogus' ('help'를 입력해 보세요)`]);
    expect(execute(s, "status").join("\n")).toContain("(배치된 유닛 없음)");
  });
});

describe("MOTD locale sections", () => {
  it("carries both en and ko sections with no Hangul in the English block", async () => {
    const { readFileSync } = await import("node:fs");
    const motd = readFileSync(new URL("../web/terminal/MOTD.txt", import.meta.url), "utf8");
    expect(motd).toContain('lang="ko"');
    expect(motd).toContain('lang="en"');
    const enBlocks = [...motd.matchAll(/<div[^>]*lang="en"[^>]*>([\s\S]*?)<\/div>/g)].map(
      (m) => m[1] ?? "",
    );
    expect(enBlocks.length).toBeGreaterThan(0);
    for (const block of enBlocks) expect(block).not.toMatch(/[\uac00-\ud7a3]/);
    // The shared locale rule (bt10x.css, loaded by the terminal) hides the other block.
    const css = readFileSync(new URL("../web/bt10x.css", import.meta.url), "utf8");
    expect(css).toContain(":root:lang(en) :lang(ko)");
    expect(css).toContain(":root:lang(ko) :lang(en)");
  });
});

describe("landing page locale spans", () => {
  it("pairs every en span with a ko span and keeps Hangul out of English", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const spans = (lang: string) =>
      [...html.matchAll(new RegExp(`<span lang="${lang}">([^<]*)</span>`, "g"))].map(
        (m) => m[1] ?? "",
      );
    const enSpans = spans("en");
    const koSpans = spans("ko");
    expect(enSpans.length).toBeGreaterThan(0);
    expect(koSpans.length).toBe(enSpans.length);
    for (const text of enSpans) expect(text).not.toMatch(/[가-힣]/);
    for (const text of koSpans) expect(text.trim()).not.toBe("");
    const css = readFileSync(new URL("../web/bt10x.css", import.meta.url), "utf8");
    expect(css).toContain(":root:lang(en) :lang(ko)");
    expect(css).toContain(":root:lang(ko) :lang(en)");
  });
});
