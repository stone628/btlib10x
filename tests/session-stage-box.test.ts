import { describe, expect, it } from "vitest";
import type { GameEvent } from "../src/rules/game";
import type { Session } from "../web/session";
import { handleSessionGameEvents } from "../web/session.common";

const stage = (s: "begin" | "weaponDone" | "physicalDone" | "end"): GameEvent => ({
  kind: "attackPhaseStage",
  stage: s,
  turn: 3,
});
const initiative: GameEvent = { kind: "initiative", rolls: { 1: 8, 2: 4 }, winnerTeam: 1 };

function render(events: GameEvent[]): string[] {
  return handleSessionGameEvents({} as Session, events).flatMap((c) =>
    c.kind === "lines" ? [...c.lines] : [],
  );
}

describe("attack-stage log boxes", () => {
  it("frames a stage's lines under its title", () => {
    const lines = render([stage("begin"), initiative, stage("weaponDone")]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("┌[Weapon Attacks — turn 3]");
    expect(lines[1]?.startsWith("└─ initiative")).toBe(true);
  });

  it("draws inner lines with │ and the last line with the corner", () => {
    const lines = render([stage("begin"), initiative, initiative, stage("weaponDone")]);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith("│  initiative")).toBe(true);
    expect(lines[2]?.startsWith("└─ initiative")).toBe(true);
  });

  it("renders nothing for an empty stage and closes on end", () => {
    const lines = render([
      stage("begin"),
      stage("weaponDone"),
      stage("physicalDone"),
      initiative,
      stage("end"),
      initiative,
    ]);
    expect(lines[0]).toBe("┌[Attack Aftermath — turn 3]");
    expect(lines[1]?.startsWith("└─ initiative")).toBe(true);
    expect(lines[2]?.startsWith("initiative")).toBe(true);
    expect(lines).toHaveLength(3);
  });
});
