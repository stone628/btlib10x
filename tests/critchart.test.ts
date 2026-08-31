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
    // Row 1: right arm | head | left arm (single header line, in that order).
    const row1 = text.split("\n").find((l) => l.includes("[ RA ]"));
    expect(row1).toBeDefined();
    expect(row1).toMatch(/^\[ RA \]\s+\[ HD \]\s+\[ LA \]\s*$/);
    // Row 2: right torso | center torso | left torso.
    const row2 = text.split("\n").find((l) => l.includes("[ RT ]"));
    expect(row2).toBeDefined();
    expect(row2).toMatch(/^\[ RT \]\s+\[ CT \]\s+\[ LT \]\s*$/);
    // Head (6 slots): dice 1-6; cockpit sits in slot 3.
    expect(text).toContain("  3 Cockpit");
    expect(text).toContain("  6 Life Support");
    // Center torso (12 slots): engine/gyro, and slot 12 empty.
    expect(text).toContain("  3 Engine");
    expect(text).toContain(" 12 -");
    // Structure labels are humanized.
    expect(text).toContain("Gyro");
    expect(text).toContain("Heat Sink");
    // Arms: shoulder + actuators + hand; ammo slots named with design capacity.
    expect(text).toContain("Shoulder");
    expect(text).toContain("Upper Arm Actuator");
    expect(text).toContain("  1 Autocannon/20 ammo 10");
    expect(text).toContain("Medium Laser");
  });

  it("renders DHS groups and named soak slots for HER-5SA", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const text = run(s, "info mech HER-5SA").join("\n");
    expect(text).toContain("  4 DHS");
    expect(text).toContain("  5 DHS");
    expect(text).toContain("  6 DHS");
    expect(text).toContain("  8 (Endo Steel)");
    expect(text).toContain("  4 (Endo Steel)");
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
    const legRow = text.split("\n").find((l) => l.includes("[ RL ]"));
    expect(legRow).toBeDefined();
    expect(legRow).toMatch(/^\[ RL \]\s+\[ LL \]\s*$/);
  });
});

describe("critical slot chart (sheet)", () => {
  it("shows live destroyed-weapon markers on all slots of the mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // Autocannon/20 is weapon index 1 (rightTorso); destroy it via crit state.
    htk.destroyedWeapons.push(1);
    const text = run(s, "sheet hunchy").join("\n");
    // Every AC/20 weapon slot in RT is flagged [DST]; structure slots are not.
    expect(text).toContain("  1 Autocannon/20 [DST]");
    expect(text).toContain(" 10 Autocannon/20 [DST]");
    // The weapons list flag for a crit-destroyed mount shows [DST], same as the chart.
    expect(text).toContain("#1 Autocannon/20 (RT)");
    expect(text).toContain("[DST]");
    // Shoulder slot (slot 1 of left arm) is a structure — untouched.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("[DST]");
  });

  it("shows [JAM] on all slots of a jammed weapon mount", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // Medium Laser (LA) is weapon index 2; jam it.
    htk.jammedWeapons.push(2);
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  5 Medium Laser [JAM]");
    expect(text).toContain("#2 Medium Laser (LA)");
    expect(text).toContain("[JAM]");
    // Structure slots on the same arm stay marker-free.
    const laLine = text.split("\n").find((l) => l.includes(" 1 Shoulder"));
    expect(laLine).not.toContain("[JAM]");
  });

  it("shows ammo-slot destroyed and remaining-shots markers", () => {
    const s = freshSetup();
    const htk = s.battle!.units.hunchy!;
    // AC/20 ammo is leftTorso slots 1-2 (also weapon index 1).
    htk.critSlotsDestroyed.leftTorso[0] = true;
    htk.ammoLeft[1] = 6;
    const text = run(s, "sheet hunchy").join("\n");
    expect(text).toContain("  1 Autocannon/20 ammo 6 [DST]");
    expect(text).toContain("  2 Autocannon/20 ammo 6");
  });
});
