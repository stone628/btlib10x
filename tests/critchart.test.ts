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

describe("critical slot chart (info mech)", () => {
  it("renders the 3-column layout with dice numbers for HBK-4G", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const text = run(s, "info mech HBK-4G").join("\n");
    expect(text).toContain("critical slots");
    // Row 1: left arm | head | right arm (single header line, in that order).
    const row1 = text.split("\n").find((l) => l.trimStart().startsWith("LA"));
    expect(row1).toBeDefined();
    expect(row1).toMatch(/^LA\s+HD\s+RA\s*$/);
    // Row 2: left torso | center torso | right torso.
    const row2 = text.split("\n").find((l) => l.trimStart().startsWith("LT"));
    expect(row2).toBeDefined();
    expect(row2).toMatch(/^LT\s+CT\s+RT\s*$/);
    // Head (6 slots): dice 1-6; cockpit sits in slot 3.
    expect(text).toContain("  3 Cockpit");
    expect(text).toContain("  6 Life Support");
    // Center torso (12 slots): engine/gyro, and slot 12 empty.
    expect(text).toContain("  3 Engine");
    expect(text).toContain(" 12 -");
    // Structure labels are humanized.
    expect(text).toContain("Gyro");
    expect(text).toContain("Heat Sink");
    // Arms: shoulder + actuators + hand; ammo slots named.
    expect(text).toContain("Shoulder");
    expect(text).toContain("Upper Arm Actuator");
    expect(text).toContain("Autocannon/20 ammo");
    expect(text).toContain("Medium Laser");
  });

  it("renders DHS groups and soak slots for HER-5SA", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const text = run(s, "info mech HER-5SA").join("\n");
    expect(text).toContain("  4 DHS");
    expect(text).toContain("  5 DHS");
    expect(text).toContain("  6 DHS");
    expect(text).toContain("  8 (soak)");
    expect(text).toContain("  4 (soak)");
  });

  it("keeps 1-6 dice for legs and renders the leg row as two columns", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const text = run(s, "info mech HBK-4G").join("\n");
    // Right leg hip at slot 1, heat sinks at 5-6.
    expect(text).toContain("  1 Hip");
    expect(text).toContain("  5 Heat Sink");
    expect(text).toContain("  6 Heat Sink");
    // Row 3 renders both legs (single header line, no middle cell).
    const legRow = text.split("\n").find((l) => l.trimStart().startsWith("LL"));
    expect(legRow).toBeDefined();
    expect(legRow).toMatch(/^LL\s+RL\s*$/);
  });
});

describe("critical slot chart (sheet)", () => {
  it("shows live destroyed-weapon markers on all slots of the mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units["hunchy"]!;
    // Autocannon/20 is weapon index 1 (rightTorso); destroy it via crit state.
    htk.destroyedWeapons.push(1);
    const text = run(s, "sheet hunchy").join("\n");
    // Every AC/20 weapon slot in RT is flagged destroyed; structure slots are not.
    expect(text).toContain("  1 Autocannon/20 destroyed");
    expect(text).toContain("  10 Autocannon/20 destroyed");
    // Shoulder slot (slot 1 of left arm) is a structure — untouched.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("destroyed");
  });

  it("shows ammo-slot destroyed and remaining-shots markers", () => {
    const s = freshSetup();
    const htk = s.battle!.units["hunchy"]!;
    // AC/20 ammo is leftTorso slots 1-2 (also weapon index 1).
    htk.critSlotsDestroyed["leftTorso"][0] = true;
    htk.ammoLeft[1] = 6;
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  1 Autocannon/20 ammo destroyed ammo 6");
    expect(text).toContain("  2 Autocannon/20 ammo ammo 6");
  });
});
