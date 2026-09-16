import { describe, expect, it } from "vitest";
import * as S from "../web/session.js";
import { execute, overrideAmmoBin } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

function freshSetup(): S.Session {
  const s = S.newSession(42);
  s.critsDisabled = true;
  run(s, "map quickstart");
  run(s, "add hunchy HBK-4G 9 9 n");
  run(s, "add cicada CDA-3MA 9 8 s");
  run(s, "start");
  return s;
}

describe("critical slot chart (sheet)", () => {
  it("shows live destroyed-weapon markers on all slots of the mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // Autocannon/20 is weapon index 4 (rightTorso); destroy it via crit state.
    htk.destroyedWeapons.push(4);
    const text = run(s, "sheet hunchy").join("\n");
    // Every AC/20 weapon slot in RT is flagged [-]; structure slots are not.
    expect(text).toContain("  1 AC/20 [-]");
    expect(text).toContain(" 10 AC/20 [-]");
    // The weapons list flag for a crit-destroyed mount shows [-], same as the chart.
    expect(text).toContain("[-] AC/20");
    // Shoulder slot (slot 1 of left arm) is a structure — untouched.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("[-]");
  });

  it("shows [J] on all slots of a jammed weapon mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // Medium Laser (LA) is weapon index 1; jam it.
    htk.jammedWeapons.push(1);
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  5 Medium Laser [J]");
    expect(text).toMatch(/#1 Medium Laser\s+\[LA\]/);
    expect(text).toContain("[J]");
    // Structure slots on the same arm stay marker-free.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("[J]");
  });

  it("shows ammo-slot destroyed and per-bin remaining-shots markers", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // AC/20 ammo is leftTorso slots 1-2 (also weapon index 4). Drain the
    // first bin down to 3; the second keeps its full 5.
    htk.critSlotsDestroyed.leftTorso[0] = true;
    overrideAmmoBin(htk.ammoBins, "leftTorso", 1, 3);
    overrideAmmoBin(htk.ammoBins, "leftTorso", 2, 5);
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  1 AC/20 ammo (3/5 shots) [-]");
    expect(text).toContain("  2 AC/20 ammo (5/5 shots)");
  });

  it("marks every non-empty slot [-] when the location's structure is destroyed by damage", () => {
    const s = freshSetup();
    const cic = s.battle!.units.cicada!;
    // Simulate left torso + left arm destroyed by raw damage (no crit roll):
    // no critSlotsDestroyed flags change, no destroyedWeapons entries.
    cic.phaseStartDamage = {
      ...cic.phaseStartDamage,
      internalStructure: { ...cic.phaseStartDamage.internalStructure, leftTorso: 0, leftArm: 0 },
    };
    const text = run(s, "sheet cicada").join("\n");
    // Every LT slot (engines, Snub-Nose PPC x2, Medium Laser) flagged.
    expect(text).toContain("  4 Snub-Nose PPC [-]");
    expect(text).toContain("  5 Snub-Nose PPC [-]");
    expect(text).toContain("  6 Medium Laser [-]");
    // LA slots flagged: the LA column sits right of the last grid divider on
    // RA/HD/LA rows; split on the box-drawing vertical to isolate it.
    const laCells = text
      .split("\n")
      .map((l) => l.split("│")[3] ?? "")
      .filter((c) => /^\s*\d+ /.test(c));
    expect(laCells.length).toBeGreaterThanOrEqual(6);
    expect(laCells[0]).toContain("Shoulder [-]");
    expect(laCells[1]).toContain("Upper Arm Actuator [-]");
    // Empty LA slots stay bare.
    const laEmpty = laCells.find((c) => c.trim().match(/^\d+ -/));
    expect(laEmpty).toBeDefined();
    expect(laEmpty).not.toContain("[-]");
    // Intact locations keep clean slots: RT engine slot 1 has no marker
    // (first grid cell of the RT/CT/LT row block).
    const rtRow = text.split("\n").find((l) => l.split("│")[1]?.includes("  1 Engine"));
    expect(rtRow).toBeDefined();
    expect(rtRow!.split("│")[1]).not.toContain("[-]");
  });
});
