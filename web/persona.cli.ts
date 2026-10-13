/**
 * CLI face of the persona player (`web/persona.ts`): the `pp` command, the
 * synchronous driver that types a persona unit's commands at its prompt, and
 * the reasoning trace, rendered as a `[ID -> TARGET]` box exactly like attack
 * resolution lines.
 *
 * The driver runs right after `start`, `rematch` and `done` (and on `pp go`),
 * never after `rollback`: a rolled-back persona prompt waits, so the same
 * decision can be replayed with `pp go` or the turn played by hand.
 */
import { buildCollapsibleChunk, buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import type { CmdDef } from "./cli";
import type { MessageKey } from "./i18n/index";
import { i18n } from "./i18n/index";
import { decide, promptActorId, promptPersona, type TraceLevel } from "./persona";
import type { DecisionTrace, TraceCandidate, TraceNote, TraceTerm } from "./persona.common";
import { isPersonaKey, PERSONA_KEYS, PERSONAS } from "./persona.data";
import { PP_SETUP_USAGE, randomPersonaSetup } from "./persona.setup";
import { handleSessionGameEvents, promptBody, type Session } from "./session";

/** Commands after which a persona prompt is played automatically. */
const DRIVE_AFTER: ReadonlySet<string> = new Set(["start", "rematch", "done"]);
/** Decisions per drive before the driver hands control back (a stalled DP-vs-DP bout). */
export const MAX_DECISIONS_PER_DRIVE = 2000;
/** Candidates listed in a brief trace. */
const BRIEF_CANDIDATES = 3;
const TRACE_LEVELS: readonly TraceLevel[] = ["off", "brief", "full"];

const POSTURE_KEY: Readonly<Record<DecisionTrace["posture"], MessageKey>> = {
  approach: "pp.posture.approach",
  engage: "pp.posture.engage",
  hold: "pp.posture.hold",
  recover: "pp.posture.recover",
  yield: "pp.posture.yield",
};

const TERM_KEY: Readonly<Record<TraceTerm["id"], MessageKey>> = {
  range: "pp.term.range",
  cover: "pp.term.cover",
  tmm: "pp.term.tmm",
  flank: "pp.term.flank",
  melee: "pp.term.melee",
  charge: "pp.term.charge",
  recoil: "pp.term.recoil",
  exposed: "pp.term.exposed",
  heat: "pp.term.heat",
  crowd: "pp.term.crowd",
  ev: "pp.term.ev",
  ammo: "pp.term.ammo",
};

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function termsText(terms: readonly TraceTerm[]): string {
  if (terms.length === 0) return i18n("pp.trace.noTerms");
  return terms.map((t) => `${i18n(TERM_KEY[t.id])} ${signed(t.value)}`).join(" ");
}

function candidateLine(c: TraceCandidate, rank: number): string {
  return i18n("pp.trace.candidate", {
    rank,
    label: c.label,
    score: signed(c.score),
    terms: termsText(c.terms),
  });
}

function noteLine(n: TraceNote): string {
  return i18n(n.key, n.params);
}

/** Why #1 won: its two strongest terms, its worst cost, and its lead over #2. */
function groundsText(candidates: readonly TraceCandidate[]): string {
  const best = candidates[0]!;
  const pros = best.terms
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2);
  const con = best.terms.filter((t) => t.value < 0).sort((a, b) => a.value - b.value)[0];
  const parts = [`${best.label}`];
  if (pros.length > 0) parts.push(i18n("pp.trace.pros", { terms: termsText(pros) }));
  if (con !== undefined) parts.push(i18n("pp.trace.cons", { terms: termsText([con]) }));
  const second = candidates[1];
  if (second !== undefined) {
    parts.push(i18n("pp.trace.leadOver", { margin: signed(best.score - second.score) }));
  }
  return parts.join("; ");
}

/** Trace body lines (without the `[ID -> TARGET]` header the event renderer adds). */
export function traceLines(trace: DecisionTrace, limit: number): string[] {
  const lines = [
    i18n("pp.trace.head", {
      persona: PERSONAS[trace.persona].name,
      posture: i18n(POSTURE_KEY[trace.posture]),
      target: trace.targetId ?? "-",
      held: trace.targetHeld,
    }),
  ];
  for (const n of trace.notes) lines.push(noteLine(n));
  if (trace.candidates.length > 0) {
    lines.push(
      i18n("pp.trace.options", {
        phase: i18n(
          trace.phase === "movement" ? "pp.trace.phase.movement" : "pp.trace.phase.attack",
        ),
        count: trace.candidates.length,
        heat: trace.heat,
        ceiling: trace.heatCeiling,
      }),
    );
    trace.candidates.slice(0, limit).forEach((c, i) => {
      lines.push(candidateLine(c, i + 1));
    });
    lines.push(i18n("pp.trace.chose", { grounds: groundsText(trace.candidates) }));
  }
  lines.push(i18n("pp.trace.commands", { commands: trace.commands.join("; ") }));
  return lines;
}

/** The trace as chunks: the box like attack resolution, plus the full list when asked. */
export function traceChunks(s: Session, trace: DecisionTrace, level: TraceLevel): Chunk[] {
  if (level === "off") return [];
  const chunks = handleSessionGameEvents(s, [
    {
      kind: "personaDecision",
      actorId: trace.actorId,
      targetId: trace.targetId,
      lines: traceLines(trace, BRIEF_CANDIDATES),
    },
  ]);
  if (level === "full" && trace.candidates.length > BRIEF_CANDIDATES) {
    const rest = trace.candidates
      .slice(BRIEF_CANDIDATES)
      .map((c, i) => candidateLine(c, i + 1 + BRIEF_CANDIDATES));
    chunks.push(
      buildCollapsibleChunk(
        i18n("pp.trace.more", {
          count: rest.length,
          phase: i18n(
            trace.phase === "movement" ? "pp.trace.phase.movement" : "pp.trace.phase.attack",
          ),
        }),
        [buildLinesChunk(...rest)],
      ),
    );
  }
  return chunks;
}

let driving = false;

/** True for commands after which `runChunks` hands the prompt to the persona player. */
export function drivesAfter(command: string): boolean {
  return DRIVE_AFTER.has(command.toLowerCase());
}

/**
 * Play every consecutive persona prompt: decide, show the trace, then type
 * the commands through `run` (the normal CLI dispatch, so `commitAtomic`,
 * replay recording and rollback snapshots all apply). The next persona
 * context is installed before the commands run, so the snapshot taken at the
 * following prompt already holds it; a failed command restores it and stops.
 */
export function drivePersona(s: Session, run: (raw: string) => Chunk[]): Chunk[] {
  if (driving) return [];
  driving = true;
  const out: Chunk[] = [];
  try {
    for (let n = 0; ; n++) {
      if (n >= MAX_DECISIONS_PER_DRIVE) {
        out.push(buildLinesChunkWith("banner", i18n("pp.limit")));
        break;
      }
      const key = promptPersona(s);
      if (key === null) break;
      const decision = decide(s, key, s.persona);
      if (decision === null) break;
      const before = s.persona;
      s.persona = decision.next;
      out.push(...traceChunks(s, decision.trace, s.persona.traceLevel));
      let failed: string | null = null;
      for (const command of decision.commands) {
        out.push(buildLinesChunkWith("cmd", `${promptBody(s)} > ${command}`));
        const result = run(command);
        // The reachable-hex board of `mode` is for a human picking a landing: skip it.
        out.push(...result.filter((c) => c.kind !== "board"));
        if (result.some((c) => c.kind === "lines" && c.cls === "err")) {
          failed = command;
          break;
        }
      }
      if (failed !== null) {
        s.persona = { ...before, traceLevel: s.persona.traceLevel };
        out.push(buildLinesChunkWith("banner", i18n("pp.stopped", { command: failed })));
        break;
      }
    }
  } catch (e) {
    out.push(
      buildLinesChunkWith(
        "err",
        `${i18n("err.prefix")} ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  } finally {
    driving = false;
  }
  return out;
}

/** Hint shown when the prompt belongs to a persona but is not being played (after rollback). */
export function personaWaitingChunks(s: Session): Chunk[] {
  const key = promptPersona(s);
  const id = promptActorId(s);
  if (key === null || id === null) return [];
  return [buildLinesChunkWith("hint", i18n("pp.waiting", { id, persona: PERSONAS[key].name }))];
}

function listChunk(s: Session): Chunk {
  const entries = Object.entries(s.persona.assignments);
  return buildLinesChunk(
    i18n("pp.list.header"),
    ...(entries.length > 0
      ? entries.map(([id, key]) => i18n("pp.list.entry", { id, persona: PERSONAS[key].name }))
      : [i18n("pp.list.none")]),
    i18n("pp.list.personas", { list: PERSONA_KEYS.join(", ") }),
    i18n("pp.list.trace", { level: s.persona.traceLevel }),
  );
}

const PP_USAGE = [
  "pp [<id> <persona | off>]",
  "pp setup 2 | 4",
  "pp go | pp why [id]",
  "pp trace off | brief | full",
].join("\n");

/** `pp`: assign personas in setup; inspect, tune and resume the persona player in battle. */
export function personaCmd(run: (s: Session, raw: string) => Chunk[]): CmdDef {
  return {
    helpKey: "cmd.pp.help",
    usage: PP_USAGE,
    argsDoc: [
      ["", "cmd.pp.arg.list"],
      ["<id> <persona|off>", "cmd.pp.arg.assign"],
      ["setup 2|4", "cmd.pp.arg.setup"],
      ["go", "cmd.pp.arg.go"],
      ["why [id]", "cmd.pp.arg.why"],
      ["trace off|brief|full", "cmd.pp.arg.trace"],
    ],
    run: (s, a) => {
      const sub = a[0]?.toLowerCase();
      if (sub === undefined) return [listChunk(s)];
      if (sub === "trace") {
        const level = a[1]?.toLowerCase() as TraceLevel | undefined;
        if (level === undefined || !TRACE_LEVELS.includes(level)) {
          throw new Error(i18n("err.expectedArgs", { usage: "pp trace off|brief|full" }));
        }
        s.persona.traceLevel = level;
        return [buildLinesChunk(i18n("pp.ok.trace", { level }))];
      }
      if (sub === "why") {
        const id = a[1] ?? promptActorId(s);
        if (id === null || id === undefined) throw new Error(i18n("err.needsActor"));
        const trace = s.persona.lastTrace[id];
        if (trace === undefined) throw new Error(i18n("pp.err.noTrace", { id }));
        return traceChunks(
          s,
          trace,
          s.persona.traceLevel === "off" ? "brief" : s.persona.traceLevel,
        );
      }
      if (sub === "go") {
        if (promptPersona(s) === null) throw new Error(i18n("pp.err.notPersonaPrompt"));
        return drivePersona(s, (raw) => run(s, raw));
      }
      // `pp setup <n>`; a roster unit literally named "setup" still takes `pp setup <persona>`.
      if (sub === "setup" && (a[1] === undefined || /^\d+$/.test(a[1]))) {
        if (a[1] === undefined) {
          throw new Error(i18n("err.expectedArgs", { usage: PP_SETUP_USAGE }));
        }
        return randomPersonaSetup(s, Number(a[1]));
      }
      // pp <id> <persona|off>
      if (s.state !== "setup") throw new Error(i18n("pp.err.setupOnly"));
      if (a.length < 2) throw new Error(i18n("err.expectedArgs", { usage: PP_USAGE }));
      const id = a[0]!;
      if (!s.setup.roster.some((r) => r.id === id)) {
        throw new Error(i18n("err.unknownUnitId", { id }));
      }
      const word = a[1]!.toLowerCase();
      if (word === "off") {
        delete s.persona.assignments[id];
        return [buildLinesChunk(i18n("pp.ok.cleared", { id }))];
      }
      if (!isPersonaKey(word)) {
        throw new Error(
          i18n("pp.err.unknownPersona", { name: a[1]!, list: PERSONA_KEYS.join(", ") }),
        );
      }
      s.persona.assignments[id] = word;
      return [buildLinesChunk(i18n("pp.ok.assigned", { id, persona: PERSONAS[word].name }))];
    },
  };
}
