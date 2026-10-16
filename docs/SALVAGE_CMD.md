# Plan: `salvage` CLI command

Status: implemented as planned (open questions settled on the defaults). Adds a terminal command that prints the
engine's `salvageReport(state)` (`src/rules/salvage.ts`) once the battle is
over.

## Syntax

```
salvage [id]
```

- `salvage` lists every entry in the report (every unit with
  `removed !== "not"`, roster order), as a summary table followed by one
  detail block per entry.
- `salvage <id>` prints only that unit's detail block. An id that exists but
  is still operational answers `'{id}' left nothing to salvage`; an unknown id
  reuses `err.unknownUnitId`.
- No entries at all prints one line: `nothing to salvage`.

## What the report provides (and what it does not)

Per `SalvageEntry`: unit id, model, team, kind (`hull` | `wreckage`), removal
reason, destroy reason (null for a hull), hex, prone, `leftWreckage` (40 t+),
per-location damage (armor, rear armor, internal structure), destroyed crit
slots, stranded ammo, and salvageable severed limbs.

**Clubs.** The report has no club list. The only club data it carries is
`severedLimbs`: limbs still lying on the board, never picked up, holding an
intact weapon. Trees and girders on the ground (`state.clubs`) and clubs
still held are not in the report, so the command does not print them. If
they should appear, that is an engine change to `salvageReport` first (open
question 1), not CLI work.

## Output layout

Summary table (`buildHeaderTableChunkFromRows`, as `info mech` does), then
per entry a detail block (`buildLinesChunk`). Location columns reuse
`SHORT_LOC` (`web/terminal/misc.ts`); reason text reuses the existing
`REMOVAL_REASON_KEY` / `DESTROYED_REASON_KEY` maps in
`web/terminal/session.common.ts` (export them, or add a small
`removalLabel(removed, destroyed)` helper beside `sheetIdLine`); posture
reuses `PRN`.

Example (`lang en`):

```
salvage (2):
  id   model    team  kind      reason                       hex    posture   wreckage
  hbk  HBK-4G   1     hull      pilot ejected                2,4    standing  -
  enf  ENF-4R   2     wreckage  destroyed, CT destroyed      5,4    prone     yes

hbk HBK-4G (team 1) - hull
  armor     HD 9  CT 22/8  LT 18/6  RT 15/6  LA 16  RA 16  LL 20  RL 20
  structure HD 3  CT 18    LT 13    RT 13    LA 10  RA 10  LL 13  RL 13
  destroyed slots: none
  stranded ammo: none
  severed limbs: none

enf ENF-4R (team 2) - wreckage
  armor     HD 0  CT 0/0  LT 4/2  RT 0/0  LA 0  RA 6  LL 12  RL 3
  structure HD 1  CT 0    LT 7    RT 0    LA 0  RA 8  LL 12  RL 9
  destroyed slots: CT 1 Engine, RT 4 ammo:AC/10, LA 5 Medium Laser
  stranded ammo: AC/10 x7 (RT bin)
  severed limbs: LA
```

Korean (`lang ko`) uses the same layout with translated headers and labels;
`SHORT_LOC` abbreviations, model names, weapon names and `ammo:<weapon>`
stay untranslated, as on `sheet`. Torso cells show `front/rear`.

## Phase gating

Register `salvage` in `OVER_CMDS` only (`web/terminal/cli.ts`). The
dispatcher already handles every other state: a command found in
`allCmds()` but not in `availableCmds(session)` throws `err.notInPhase`, so
in setup or mid-battle the user sees

- en: `error: 'salvage' is not available in this phase (try 'help salvage' to read about it)`
- ko: `오류: 'salvage'은(는) 이 단계에서 사용할 수 없습니다 ('help salvage'으로 설명을 볼 수 있습니다)`

`help salvage` works in every phase (help reads `allCmds()`). The
`salvageChunks(s, id?)` builder also guards with
`if (s.state !== "over") throw new Error(i18n("err.notOver"))`, like
`victoryBannerChunk`, so direct callers cannot bypass the gate. No new
error string is needed for gating.

`salvage` reads state only, so it needs no `drivesAfter` entry and records
a prompt snapshot like any other command (harmless).

## Files to touch

- `web/terminal/session.over.ts`: `salvageChunks(s, id?)` builds the summary
  table and detail blocks from `salvageReport(s.battle!)`.
- `web/terminal/session.common.ts`: export a `removalLabel` helper (or the
  two reason maps) for reuse.
- `web/terminal/cli.ts`: `salvage` entry in `OVER_CMDS` (`helpKey`,
  `usage: "salvage [id]"`, `argsDoc`), plus the import.
- `web/terminal/i18n/en.ts` and `ko.ts`: `cmd.salvage.help`,
  `cmd.salvage.arg.id`, `salvage.title`, column headers (`salvage.col.*`),
  `salvage.kind.hull` / `salvage.kind.wreckage`, `salvage.entryHeader`,
  `salvage.armor`, `salvage.structure`, `salvage.slots`, `salvage.ammo`,
  `salvage.ammoBin`, `salvage.limbs`, `salvage.none`, `salvage.empty`,
  `salvage.notSalvage`. Update `hint.over` to mention `salvage`.
- `docs/CLI.md`: add the row to the `### over` command table.
- `docs/API.md`: no change (engine API unchanged).

Proposed strings:

| key | en | ko |
|---|---|---|
| `cmd.salvage.help` | list hulls and wreckage left on the field | 전장에 남은 기체와 잔해 목록 |
| `cmd.salvage.arg.id` | show one unit's salvage detail only | 한 유닛의 회수 상세만 표시 |
| `salvage.title` | salvage ({n}): | 회수 목록 ({n}): |
| `salvage.kind.hull` | hull | 기체 |
| `salvage.kind.wreckage` | wreckage | 잔해 |
| `salvage.slots` | destroyed slots: {list} | 파괴된 슬롯: {list} |
| `salvage.ammo` | stranded ammo: {list} | 남은 탄약: {list} |
| `salvage.limbs` | severed limbs: {list} | 절단된 사지: {list} |
| `salvage.none` | none | 없음 |
| `salvage.empty` | nothing to salvage | 회수할 것이 없습니다 |
| `salvage.notSalvage` | '{id}' left nothing to salvage | '{id}'은(는) 회수할 것이 없습니다 |

## Tests

- New `tests/salvage-cmd.test.ts`, driving a session to over with the
  `driveToOver` pattern from `tests/session-contexts.test.ts` (both units
  eject, so two hull entries):
  - `salvage` in over lists both ids, kind `hull`, reason `pilot ejected`.
  - `salvage <id>` prints only that unit's block.
  - `salvage <operational id>` and `salvage nosuch` give the expected errors.
  - `salvage` in setup and during movement returns `err.notInPhase`.
  - A wreckage case: build the battle state with `destroyBySweep` as in
    `tests/hull.test.ts`, then check `destroyed slots`, `wreckage yes` and
    `severed limbs` lines from `salvageChunks`.
  - `lang ko` then `salvage` shows the Korean title and kind labels.
- `tests/i18n.test.ts` already fails if `ko` misses any new `en` key.
- Done criteria: `npm run build && npm run lint && npm run typecheck && npm test`
  (build first: session tests run against `dist/`).

## Open questions

1. Should ground clubs (`state.clubs` trees and girders) and dropped held
   clubs be part of salvage? Default: no, the command mirrors the report.
2. Persona games: should `salvage` print automatically after the victory
   banner? Default: no, user-invoked only.

## Revision: salvageable weapons and equipment

Destroyed slots and the severed-limb line are no longer printed. Each entry
now lists what can be recovered, from the new `SalvageEntry.salvageable`
(`SalvageItem`: kind, name, location, severed, count):

- **Recoverable locations:** a location with internal structure left, or a
  severed limb never picked up (`blownOffLimbs[].salvageable`). A location
  lost to damage, or a limb used as a club, yields nothing.
- **Weapons:** every mount not critted (`isWeaponCritted`); a split mount
  needs both its locations recoverable.
- **Equipment:** heat sinks, double heat sinks (one per device, as in
  `heat.ts`), jump jets and the targeting computer. Frame parts (engine,
  gyro, cockpit, sensors, life support, actuators) stay with the hull or
  wreckage and are not listed. Ammo stays in `strandedAmmo`.

```
salvageable:
  CT: CL Machine Gun
  RT: CL Machine Gun, CL LRM 20
  RA: CL ER Large Laser, CL ER Medium Laser, DHS
  LA (severed): CL ER Large Laser, CL ER Medium Laser, DHS
stranded ammo: none
```

## Revision: two-column detail

`salvage` alone prints the roster table; `salvage <id>` prints one unit as
a unit line plus a header table in the style of `sheet`:

```
a TBR-Prime (team 1) - hull, pilot ejected, 5,5 standing
┌────────────────────────────────────────────────┬──────────────────────────────────┐
│salvageables                                    │salvaged hull                     │
├────────────────────────────────────────────────┼──────────────────────────────────┤
│weapons & equipment:                            │              [ HD ]              │
│  CT: CL Machine Gun                            │               3/ 3I              │
│  RT: CL Machine Gun, CL LRM 20                 │               9/ 9A              │
│  LT: CL Medium Pulse Laser, CL LRM 20          │       [ RT ] [ CT ] [ LT ]       │
│  RA: CL ER Large Laser, CL ER Medium Laser, DHS│[ RA ] 16/16I 23/23I 16/16I [ LA ]│
│  LA (severed): CL ER Large Laser,              │12/12I 25/25F 36/36F 25/25F  0/12I│
│                CL ER Medium Laser, DHS         │24/24A  7/ 7R  9/ 9R  7/ 7R  0/24A│
│stranded ammo: none                             │       [ RL ]        [ LL ]       │
│                                                │       16/16I        16/16I       │
│                                                │       32/32A        32/32A       │
└────────────────────────────────────────────────┴──────────────────────────────────┘
```

- The right column is the `sheet` armor diagram (`armorDiagramLines` in
  `session.common.ts`, shared with `sheet`) without the status, core
  component and heat panels.
- Wreckage prints the `salvageables` column only.
- Location lists wrap past 48 columns under their first item.
- Korean headers: 회수 가능 / 회수 기체; sections 무기 및 장비 / 남은 탄약.
