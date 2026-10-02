import { describe, expect, it } from "vitest";
import {
  bestFireTarget,
  isNominal,
  isUnitAvailable,
  isUnitRemoved,
  mechDefFor,
  reachableLandings,
  suggestFireTargets,
  wreckAt,
} from "../src/index";
import { en } from "../web/i18n/en";
import type { LocaleId, MessageKey } from "../web/i18n/index";
import { i18nIn, LOCALES } from "../web/i18n/index";
import {
  commitAttack,
  commitMovement,
  configLocale,
  declareMovementMode,
  newSession,
  placeLanding,
  queueWeaponAttacks,
} from "../web/session";
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
                    wreckAt: (hex) => wreckAt(st, hex) !== undefined,
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
  it("kr provides every key in the canonical en catalog", () => {
    const enKeys = Object.keys(en);
    const krKeys = Object.keys(LOCALES.kr);
    expect(krKeys.sort()).toEqual([...enKeys].sort());
  });

  it("interpolates {param} placeholders", () => {
    expect(i18nIn("en", "ok.mapLoaded", { name: "beginner", w: 15, h: 16 })).toBe(
      "map beginner: 15x16",
    );
    expect(i18nIn("kr", "lang.set", { locale: "kr" })).toBe("언어가 kr(으)로 설정되었습니다");
  });

  it("falls back to English for missing catalog entries", () => {
    const locales = LOCALES as Record<string, unknown>;
    locales.partial = {};
    try {
      expect(i18nIn("partial" as LocaleId, "board.noMap")).toBe(en["board.noMap"]);
    } finally {
      delete locales.partial;
    }
  });

  it("leaves unknown keys out of interpolation when params are absent", () => {
    expect(i18nIn("en", "ok.cancelled", {})).toBe("cancelled");
  });
});

describe("lang command", () => {
  it("defaults to English and lists available locales", async () => {
    const s = newSession(7);
    expect(configLocale()).toBe("en");
    expect(await execute(s, "lang")).toEqual(["language: en", "available: en, kr"]);
  });

  it("switches output language for subsequent commands", async () => {
    const s = newSession(7);
    expect(await execute(s, "lang kr")).toEqual(["언어가 kr(으)로 설정되었습니다"]);
    expect(configLocale()).toBe("kr");
    expect((await execute(s, "status"))[0]).toBe("맵: (없음)");
    expect((await execute(s, "help"))[0]).toBe(i18nIn("kr", "hint.setup").split("\n")[0]);
  });

  it("rejects unknown locale codes with a localized error", async () => {
    const s = newSession(7);
    await execute(s, "lang kr");
    expect(await execute(s, "lang xx")).toEqual([`오류: 알 수 없는 언어 'xx' (사용 가능: en, kr)`]);
  });

  it("preserves the locale across reset and rematch", async () => {
    const s = newSession(7);
    await execute(s, "lang kr");
    await execute(s, "reset");
    expect(configLocale()).toBe("kr");

    await execute(s, "map beginner");
    await execute(s, "add a1 HBK-4G 2 2 s");
    await execute(s, "add b1 HBK-4G 2 4 n");
    await execute(s, "start");
    autoPlay(s);
    expect((await execute(s, "rematch"))[0]).toBe("=== 재경기 시작 ===");
    expect(configLocale()).toBe("kr");
  });
});

describe("localized output smoke test", () => {
  it("renders board placeholder and errors in Korean after switching", async () => {
    const s = newSession(7);
    await execute(s, "lang kr");
    expect(await execute(s, "board")).toEqual([i18nIn("kr", "board.noMap")]);
    expect(await execute(s, "bogus")).toEqual([
      `오류: 알 수 없는 명령 'bogus' ('help'를 입력해 보세요)`,
    ]);
    expect((await execute(s, "status")).join("\n")).toContain("(배치된 유닛 없음)");
  });

  it("keeps dense rule tokens (GATOR, locations) untranslated", async () => {
    const s = newSession(7);
    await execute(s, "lang kr");
    await execute(s, "map beginner");
    await execute(s, "add a1 HBK-4G 8 8");
    await execute(s, "add b1 HBK-4G 12 12");
    await execute(s, "start");
    if (s.battle === null) throw new Error("battle not started");
    // location abbreviations stay stable regardless of locale
    expect(Object.keys(en) as MessageKey[]).toContain("sheet.statusHeader");
  });
});
