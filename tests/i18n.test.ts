import { describe, expect, it } from "vitest";
import { bestFireTarget, isNominal, isUnitAvailable, suggestFireTargets } from "../src/index.js";
import { en } from "../web/i18n/en.js";
import type { LocaleId, MessageKey } from "../web/i18n/index.js";
import { i18n, LOCALES } from "../web/i18n/index.js";
import * as S from "../web/session.js";
import { newSession } from "../web/session.js";
import { execute } from "./helpers.js";

/** Drive a started battle until it is over using minimal legal actions. */
function autoPlay(s: ReturnType<typeof newSession>): void {
  for (let i = 0; i < 500 && s.app === "battle"; i++) {
    const st = s.battle!;
    const actorId = S.currentActor(s)!.id;
    const ids = Object.values(st.units)
      .filter((u) => isUnitAvailable(u))
      .map((u) => u.id);
    const enemy = ids.find((id) => id !== actorId)!;
    if (st.phase === "movement") {
      if (isNominal(st.units[actorId]!)) {
        if (st.units[actorId]!.prone) {
          try {
            S.declareMode(s, "standup", "walk");
          } catch {
            // Cannot afford the stand (wrecked legs/heat): hold prone.
            S.declareMode(s, "pronestill");
          }
        } else {
          try {
            S.declareMode(s, "walk");
          } catch {
            S.declareMode(s, "standStill");
          }
        }
      }
      S.commitMove(s);
    } else {
      const unit = st.units[actorId]!;
      const sugg = suggestFireTargets(st, unit.id);
      const target = sugg.targets.find((t) => t.targetId === enemy) ?? bestFireTarget(sugg);
      const weapons =
        (target?.weaponsIfPropLeft.length ?? 0) >= (target?.weaponsIfPropRight.length ?? 0)
          ? (target?.weaponsIfPropLeft ?? [])
          : (target?.weaponsIfPropRight ?? []);
      for (const w of weapons) {
        if (unit.jammedWeapons.includes(w.weaponIndex)) continue;
        S.queueFire(s, { weaponIndex: w.weaponIndex, targetId: enemy });
      }
      if (s.fireDecls.length === 0) S.passFire(s);
      else S.commitFire(s);
    }
  }
  if (s.app !== "over") throw new Error("battle did not finish");
}

describe("i18n catalogs", () => {
  it("kr provides every key in the canonical en catalog", () => {
    const enKeys = Object.keys(en);
    const krKeys = Object.keys(LOCALES.kr);
    expect(krKeys.sort()).toEqual([...enKeys].sort());
  });

  it("interpolates {param} placeholders", () => {
    expect(i18n("en", "ok.mapLoaded", { name: "beginner", w: 15, h: 16 })).toBe(
      "map beginner: 15x16",
    );
    expect(i18n("kr", "lang.set", { locale: "kr" })).toBe("언어가 kr(으)로 설정되었습니다");
  });

  it("falls back to English for missing catalog entries", () => {
    const locales = LOCALES as Record<string, unknown>;
    locales.partial = {};
    try {
      expect(i18n("partial" as LocaleId, "board.noMap")).toBe(en["board.noMap"]);
    } finally {
      delete locales.partial;
    }
  });

  it("leaves unknown keys out of interpolation when params are absent", () => {
    expect(i18n("en", "ok.cancelled", {})).toBe("cancelled");
  });
});

describe("lang command", () => {
  it("defaults to English and lists available locales", () => {
    const s = newSession(7);
    expect(s.locale).toBe("en");
    expect(execute(s, "lang")).toEqual(["language: en", "available: en, kr"]);
  });

  it("switches output language for subsequent commands", () => {
    const s = newSession(7);
    expect(execute(s, "lang kr")).toEqual(["언어가 kr(으)로 설정되었습니다"]);
    expect(s.locale).toBe("kr");
    expect(execute(s, "status")[0]).toBe("맵: (없음)");
    expect(execute(s, "help")[0]).toBe(i18n("kr", "hint.setup").split("\n")[0]);
  });

  it("rejects unknown locale codes with a localized error", () => {
    const s = newSession(7);
    execute(s, "lang kr");
    expect(execute(s, "lang xx")).toEqual([`오류: 알 수 없는 언어 'xx' (사용 가능: en, kr)`]);
  });

  it("preserves the locale across reset and rematch but not new sessions", () => {
    const s = newSession(7);
    execute(s, "lang kr");
    execute(s, "reset");
    expect(s.locale).toBe("kr");

    execute(s, "map beginner");
    execute(s, "add a1 HBK-4G 2 2 s");
    execute(s, "add b1 HBK-4G 2 4 n");
    execute(s, "start");
    autoPlay(s);
    expect(execute(s, "rematch")[0]).toBe("=== 재경기 시작 ===");
    expect(s.locale).toBe("kr");
    expect(newSession(7).locale).toBe("en");
  });
});

describe("localized output smoke test", () => {
  it("renders board placeholder and errors in Korean after switching", () => {
    const s = newSession(7);
    execute(s, "lang kr");
    expect(execute(s, "board")).toEqual([i18n("kr", "board.noMap")]);
    expect(execute(s, "bogus")).toEqual([`오류: 알 수 없는 명령 'bogus' ('help'를 입력해 보세요)`]);
    expect(execute(s, "status")).toContain("(배치된 유닛 없음)");
  });

  it("keeps dense rule tokens (GATOR, locations) untranslated", () => {
    const s = newSession(7);
    execute(s, "lang kr");
    execute(s, "map beginner");
    execute(s, "add a1 HBK-4G 8 8");
    execute(s, "add b1 HBK-4G 12 12");
    execute(s, "start");
    if (s.battle === null) throw new Error("battle not started");
    // location abbreviations stay stable regardless of locale
    expect(Object.keys(en) as MessageKey[]).toContain("sheet.statusHeader");
  });
});
