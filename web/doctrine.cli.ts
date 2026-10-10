/**
 * CLI face of the doctrine player (`web/doctrine.ts`): the `dp` command, the
 * synchronous driver that types a doctrine unit's commands at its prompt, and
 * the reasoning trace, rendered as a `[ID -> TARGET]` box exactly like attack
 * resolution lines.
 *
 * The driver runs right after `start`, `rematch` and `done` (and on `dp go`),
 * never after `rollback`: a rolled-back doctrine prompt waits, so the same
 * decision can be replayed with `dp go` or the turn played by hand.
 */
import { buildCollapsibleChunk, buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import type { CmdDef } from "./cli";
import { decide, promptActorId, promptDoctrine, type TraceLevel } from "./doctrine";
import type { DecisionTrace, TraceCandidate, TraceNote, TraceTerm } from "./doctrine.common";
import { DOCTRINE_KEYS, DOCTRINES, isDoctrineKey } from "./doctrine.data";
import { DP_SETUP_USAGE, randomDoctrineSetup } from "./doctrine.setup";
import type { MessageKey } from "./i18n/index";
import { i18n } from "./i18n/index";
import { handleSessionGameEvents, promptBody, type Session } from "./session";

/** Commands after which a doctrine prompt is played automatically. */
const DRIVE_AFTER: ReadonlySet<string> = new Set(["start", "rematch", "done"]);
/** Decisions per drive before the driver hands control back (a stalled DP-vs-DP bout). */
export const MAX_DECISIONS_PER_DRIVE = 2000;
/** Candidates listed in a brief trace. */
const BRIEF_CANDIDATES = 3;
const TRACE_LEVELS: readonly TraceLevel[] = ["off", "brief", "full"];

const POSTURE_KEY: Readonly<Record<DecisionTrace["posture"], MessageKey>> = {
  approach: "dp.posture.approach",
  engage: "dp.posture.engage",
  hold: "dp.posture.hold",
  recover: "dp.posture.recover",
  yield: "dp.posture.yield",
};

const TERM_KEY: Readonly<Record<TraceTerm["id"], MessageKey>> = {
  range: "dp.term.range",
  cover: "dp.term.cover",
  tmm: "dp.term.tmm",
  flank: "dp.term.flank",
  melee: "dp.term.melee",
  charge: "dp.term.charge",
  recoil: "dp.term.recoil",
  exposed: "dp.term.exposed",
  heat: "dp.term.heat",
  crowd: "dp.term.crowd",
  ev: "dp.term.ev",
  ammo: "dp.term.ammo",
};

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function termsText(terms: readonly TraceTerm[]): string {
  if (terms.length === 0) return i18n("dp.trace.noTerms");
  return terms.map((t) => `${i18n(TERM_KEY[t.id])} ${signed(t.value)}`).join(" ");
}

function candidateLine(c: TraceCandidate, rank: number): string {
  return i18n("dp.trace.candidate", {
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
  if (pros.length > 0) parts.push(i18n("dp.trace.pros", { terms: termsText(pros) }));
  if (con !== undefined) parts.push(i18n("dp.trace.cons", { terms: termsText([con]) }));
  const second = candidates[1];
  if (second !== undefined) {
    parts.push(i18n("dp.trace.leadOver", { margin: signed(best.score - second.score) }));
  }
  return parts.join("; ");
}

/** Trace body lines (without the `[ID -> TARGET]` header the event renderer adds). */
export function traceLines(trace: DecisionTrace, limit: number): string[] {
  const lines = [
    i18n("dp.trace.head", {
      doctrine: DOCTRINES[trace.doctrine].name,
      posture: i18n(POSTURE_KEY[trace.posture]),
      target: trace.targetId ?? "-",
      held: trace.targetHeld,
    }),
  ];
  for (const n of trace.notes) lines.push(noteLine(n));
  if (trace.candidates.length > 0) {
    lines.push(
      i18n("dp.trace.options", {
        phase: i18n(
          trace.phase === "movement" ? "dp.trace.phase.movement" : "dp.trace.phase.attack",
        ),
        count: trace.candidates.length,
        heat: trace.heat,
        ceiling: trace.heatCeiling,
      }),
    );
    trace.candidates.slice(0, limit).forEach((c, i) => {
      lines.push(candidateLine(c, i + 1));
    });
    lines.push(i18n("dp.trace.chose", { grounds: groundsText(trace.candidates) }));
  }
  lines.push(i18n("dp.trace.commands", { commands: trace.commands.join("; ") }));
  return lines;
}

/** The trace as chunks: the box like attack resolution, plus the full list when asked. */
export function traceChunks(s: Session, trace: DecisionTrace, level: TraceLevel): Chunk[] {
  if (level === "off") return [];
  const chunks = handleSessionGameEvents(s, [
    {
      kind: "doctrineDecision",
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
        i18n("dp.trace.more", {
          count: rest.length,
          phase: i18n(
            trace.phase === "movement" ? "dp.trace.phase.movement" : "dp.trace.phase.attack",
          ),
        }),
        [buildLinesChunk(...rest)],
      ),
    );
  }
  return chunks;
}

let driving = false;

/** True for commands after which `runChunks` hands the prompt to the doctrine player. */
export function drivesAfter(command: string): boolean {
  return DRIVE_AFTER.has(command.toLowerCase());
}

/**
 * Play every consecutive doctrine prompt: decide, show the trace, then type
 * the commands through `run` (the normal CLI dispatch, so `commitAtomic`,
 * replay recording and rollback snapshots all apply). The next doctrine
 * context is installed before the commands run, so the snapshot taken at the
 * following prompt already holds it; a failed command restores it and stops.
 */
export function driveDoctrine(s: Session, run: (raw: string) => Chunk[]): Chunk[] {
  if (driving) return [];
  driving = true;
  const out: Chunk[] = [];
  try {
    for (let n = 0; ; n++) {
      if (n >= MAX_DECISIONS_PER_DRIVE) {
        out.push(buildLinesChunkWith("banner", i18n("dp.limit")));
        break;
      }
      const decision = decide(s);
      if (decision === null) break;
      const before = s.doctrine;
      s.doctrine = decision.next;
      out.push(...traceChunks(s, decision.trace, s.doctrine.traceLevel));
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
        s.doctrine = { ...before, traceLevel: s.doctrine.traceLevel };
        out.push(buildLinesChunkWith("banner", i18n("dp.stopped", { command: failed })));
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

/** Hint shown when the prompt belongs to a doctrine but is not being played (after rollback). */
export function doctrineWaitingChunks(s: Session): Chunk[] {
  const key = promptDoctrine(s);
  const id = promptActorId(s);
  if (key === null || id === null) return [];
  return [buildLinesChunkWith("hint", i18n("dp.waiting", { id, doctrine: DOCTRINES[key].name }))];
}

function listChunk(s: Session): Chunk {
  const entries = Object.entries(s.doctrine.assignments);
  return buildLinesChunk(
    i18n("dp.list.header"),
    ...(entries.length > 0
      ? entries.map(([id, key]) => i18n("dp.list.entry", { id, doctrine: DOCTRINES[key].name }))
      : [i18n("dp.list.none")]),
    i18n("dp.list.doctrines", { list: DOCTRINE_KEYS.join(", ") }),
    i18n("dp.list.trace", { level: s.doctrine.traceLevel }),
  );
}

const DP_USAGE = "dp [<id> <doctrine|off> | setup 2|4 | go | why [id] | trace off|brief|full]";

/** `dp`: assign doctrines in setup; inspect, tune and resume the doctrine player in battle. */
export function doctrineCmd(run: (s: Session, raw: string) => Chunk[]): CmdDef {
  return {
    helpKey: "cmd.dp.help",
    usage: DP_USAGE,
    argsDoc: [
      ["", "cmd.dp.arg.list"],
      ["<id> <doctrine|off>", "cmd.dp.arg.assign"],
      ["setup 2|4", "cmd.dp.arg.setup"],
      ["go", "cmd.dp.arg.go"],
      ["why [id]", "cmd.dp.arg.why"],
      ["trace off|brief|full", "cmd.dp.arg.trace"],
    ],
    run: (s, a) => {
      const sub = a[0]?.toLowerCase();
      if (sub === undefined) return [listChunk(s)];
      if (sub === "trace") {
        const level = a[1]?.toLowerCase() as TraceLevel | undefined;
        if (level === undefined || !TRACE_LEVELS.includes(level)) {
          throw new Error(i18n("err.expectedArgs", { usage: "dp trace off|brief|full" }));
        }
        s.doctrine.traceLevel = level;
        return [buildLinesChunk(i18n("dp.ok.trace", { level }))];
      }
      if (sub === "why") {
        const id = a[1] ?? promptActorId(s);
        if (id === null || id === undefined) throw new Error(i18n("err.needsActor"));
        const trace = s.doctrine.lastTrace[id];
        if (trace === undefined) throw new Error(i18n("dp.err.noTrace", { id }));
        return traceChunks(
          s,
          trace,
          s.doctrine.traceLevel === "off" ? "brief" : s.doctrine.traceLevel,
        );
      }
      if (sub === "go") {
        if (promptDoctrine(s) === null) throw new Error(i18n("dp.err.notDoctrinePrompt"));
        return driveDoctrine(s, (raw) => run(s, raw));
      }
      // `dp setup <n>`; a roster unit literally named "setup" still takes `dp setup <doctrine>`.
      if (sub === "setup" && (a[1] === undefined || /^\d+$/.test(a[1]))) {
        if (a[1] === undefined) {
          throw new Error(i18n("err.expectedArgs", { usage: DP_SETUP_USAGE }));
        }
        return randomDoctrineSetup(s, Number(a[1]));
      }
      // dp <id> <doctrine|off>
      if (s.state !== "setup") throw new Error(i18n("dp.err.setupOnly"));
      if (a.length < 2) throw new Error(i18n("err.expectedArgs", { usage: DP_USAGE }));
      const id = a[0]!;
      if (!s.setup.roster.some((r) => r.id === id)) {
        throw new Error(i18n("err.unknownUnitId", { id }));
      }
      const word = a[1]!.toLowerCase();
      if (word === "off") {
        delete s.doctrine.assignments[id];
        return [buildLinesChunk(i18n("dp.ok.cleared", { id }))];
      }
      if (!isDoctrineKey(word)) {
        throw new Error(
          i18n("dp.err.unknownDoctrine", { name: a[1]!, list: DOCTRINE_KEYS.join(", ") }),
        );
      }
      s.doctrine.assignments[id] = word;
      return [buildLinesChunk(i18n("dp.ok.assigned", { id, doctrine: DOCTRINES[word].name }))];
    },
  };
}
