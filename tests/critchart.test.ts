import { describe, expect, it } from "vitest";
import * as S from "../web/session.js";
import { execute } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

function freshSetup(): S.Session {
  const s = S.newSession(42);
  s.critsDisabled = true;
  run(s, "map quickstart");
  run(s, "add hunchy HBK-4G 0 4 9 9 n");
  run(s, "add cicada CDA-3MA 1 4 9 8 s");
  run(s, "start");
  return s;
}

describe("critical slot chart (sheet)", () => {
  it("shows live destroyed-weapon markers on all slots of the mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // Autocannon/20 is weapon index 1 (rightTorso); destroy it via crit state.
    htk.destroyedWeapons.push(1);
    const text = run(s, "sheet hunchy").join("\n");
    // Every AC/20 weapon slot in RT is flagged [-]; structure slots are not.
    expect(text).toContain("  1 Autocannon/20 [-]");
    expect(text).toContain(" 10 Autocannon/20 [-]");
    // The weapons list flag for a crit-destroyed mount shows [-], same as the chart.
    expect(text).toContain("#1 Autocannon/20 [RT]");
    expect(text).toContain("[-]");
    // Shoulder slot (slot 1 of left arm) is a structure — untouched.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("[-]");
  });

  it("shows [J] on all slots of a jammed weapon mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // Medium Laser (LA) is weapon index 2; jam it.
    htk.jammedWeapons.push(2);
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  5 Medium Laser [J]");
    expect(text).toMatch(/#2 Medium Laser\s+\[LA\]/);
    expect(text).toContain("[J]");
    // Structure slots on the same arm stay marker-free.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("[J]");
  });

  it("shows ammo-slot destroyed and per-bin remaining-shots markers", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // AC/20 ammo is leftTorso slots 1-2 (also weapon index 1). Drain the
    // first bin down to 3; the second keeps its full 5.
    htk.critSlotsDestroyed.leftTorso[0] = true;
    htk.ammoBins = { ...htk.ammoBins, "leftTorso:1": 3, "leftTorso:2": 5 };
    htk.shotsLeft = { ...htk.shotsLeft, 1: 8 };
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  1 Autocannon/20 ammo (3/5 shots) [-]");
    expect(text).toContain("  2 Autocannon/20 ammo (5/5 shots)");
  });
});
