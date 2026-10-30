# INSTANT.md — btlib10x Instant Action Web App

Single-page web application (`web/instant.html`) for a "pick a lance, pick a
map, drop" battle over the btlib10x core: choose 'Mechs and pilots for two
sides, a map and an engagement mode, deploy, fight, read the debrief, rematch.
Menu-driven, no text commands: every terminal command has a menu, list,
checkbox or dialog equivalent, and hexes are picked on a vector hex map.
Vanilla TypeScript + DOM over the repo's TUI kit (`web/tui.js`, see
`docs/TUI.md`); zero runtime dependencies (honors AGENTS.md). Bundled with
esbuild (dev-only).

The rules the engine simulates are the same as in the terminal; see "Status —
BattleTech Total Warfare rule coverage" in [CLI.md](CLI.md). This document
covers what Instant Action adds or does differently.

## Flow

    Title ──New battle──▶ New Battle ──Launch──▶ Deployment ──Done──▶ Battle ──▶ Debrief
      │                     ▲    ▲                   │                  │          │
      └──Random battle──────┤    │                     (roll-off, edge) │          │
                            │    └──────────── Withdraw (confirm) ──────┘          │
                            └───────────────────────── Enter (loadout kept) ───────┘
                                                       R Rematch → Battle (same deployment, seed)

- **Title** — *New battle* opens New Battle empty (no units, map or
  engagement, a fresh seed); *Random battle* builds a random loadout and
  opens it in New Battle for review (it never starts the battle).
- **New Battle** — edit the loadout; Launch (F10) goes to Deployment, Esc
  returns to the title.
- **Deployment** — roll-off for home edges, then placement; Done (F10)
  creates the battle. Esc (Discard) asks first, then returns to the title
  with the New Battle setup kept.
- **Battle** — movement and attack prompts until the engagement mode's
  stopper ends it. Withdraw (battle menu, confirm) drops the battle and
  returns to New Battle.
- **Debrief** — the result and battle record. Esc opens the debrief menu
  (below): Rematch and Edit battle setup (back to New Battle, loadout kept)
  each ask first.

The loadout lives only in memory: a reload, or *New battle* from the title,
starts from an empty one.

## Conventions

- Hex coordinates shown to the player are **1-based** `(col,row)`, as in the
  terminal and the map JSON.
- Dice flow through the same mulberry32-backed `{ d6() }` Rng as the
  terminal (`web/instant/rng.ts`, a copy), seeded from the loadout's seed:
  same loadout + seed + orders ⇒ identical battle. The deployment roll-off
  and Random battle draw from separate streams salted off the seed, so they
  never move the battle dice.
- Engine errors are caught per action: a failed commit leaves state, dice,
  log and the draft unchanged (the controller snapshots before each commit,
  as the terminal's `commitAtomic` does) and shows the message.
- Hotkeys are physical keys (`event.code`), so a Hangul IME does not break
  them; they are inactive while a text field has focus.
- Unit control is per unit: a unit without a persona is a **Player** unit,
  played by the person at the keyboard. Player units on both sides make a
  hotseat battle; none makes a spectator battle (the stand-in for the
  terminal's `autoplay`).

## Options (New Battle)

Two sides (Side 1 = team 1, ids `A1…`; Side 2 = team 2, ids `B1…`), each 1–4
'Mech slots, plus battle-wide options.

### Per unit

| option | values | terminal equivalent |
|---|---|---|
| ID | 1–12 letters, digits, `-` or `_`; unique across both sides (case-insensitive). Default `A1…A4` / `B1…B4` | `add <id>` |
| 'Mech | any catalog model (base pack + SW season pack), picked in the Choose 'Mech dialog; a new slot gets a random one (below) | `add … <model>`, `set <id> model` |
| Gunnery / Piloting | 0–7 (defaults 4 / 5) | `set <id> gunnery\|piloting` |
| MaxHit | 4–8 pilot hits (default 6, TW pp. 41–42; 7–8 a house rule with a scaled consciousness table) | `set <id> pilotHitMax` |
| Control | Player, or one of the seven personas (a new slot gets a random persona, never Player) | `pp <id> <persona\|off>` |
| Policy | ammo policy (exposed, core, spread, least first), auto-eject on/off, flamers deal heat on/off, AMS (expected, first hit, priority, off); Defaults resets | `set <id> ammoPolicy\|autoEject\|heatFlamer\|amsPolicy` |

Slots are added one at a time up to four per side and removed individually.
[+] fills the new slot at once: the next free id, default skills, MaxHit and
policy, a random persona, and a random MUL-BV 'Mech: any 'Mech while the
other side is empty, else one with 90–110 % of the other side's average BV
(the closest BV when none falls in that band).

### Battle-wide

| option | values |
|---|---|
| Map | not chosen (default), or every catalog map: the engine maps plus the Instant-Action-only map pack (see Build) |
| Random seed | 0–2147483647 (random for each new loadout); a reroll button draws a new one |
| Engagement | not chosen (default), Annihilation or Attrition (see Victory) |
| Turn limit | Attrition only: 3–30 (default 10) |
| Persona pace | instant, step (default) or timed (see Persona players); kept between visits |

Each side's total MUL Battle Value is shown for balance. Launch is blocked,
with the reason shown, while a side is empty, a slot has no 'Mech, two
units share an id, or the map or engagement is not chosen.

### Choose 'Mech

The terminal's `info mech` filters as controls over the catalog manifest:
a name search (model, chassis, Clan name), weight classes (any mix of
light / medium / heavy / assault), tech base (any, IS, Clan), pack (any,
base, sw), an era cap (intro year ≤ N, default 3150) and sort (tonnage,
name, BV, intro). The selected 'Mech's summary shows class, tonnage, tech
base, intro year, BV, walk / run / jump, its weapons (location, ammo of the
shared pool, heat, damage) and armor / internal structure per location.

### Random battle

Draws 2–4 'Mechs a side with MUL BV, every unit a random persona (pick
Player units yourself): Side 1 freely, Side 2 balanced toward Side 1's BV
total (±10 %); a random map, Annihilation, and a fresh random seed on every
entry. It stops on New Battle; Launch starts it.

## Deployment (TW p. 256)

| TW rule | Instant Action |
|---|---|
| Both sides roll 2D6; the higher chooses a home map edge, the other side takes the opposite edge | As written; ties re-roll and are listed. Edges: North (row 1), South (last row), West (column 1), East (last column) |
| Units start off the map and enter along the home edge; the entry hex is the first hex of movement | The engine has no off-map units: every unit is placed on a home-edge hex before turn 1, facing into the map. **House rule:** that first placement is free; movement starts from it |
| Leaving by the home edge is a retreat (p. 257) | Not modeled; Withdraw ends the whole battle instead |

- If the roll-off winner's side has a Player unit, the player chooses the
  edge (compass buttons, arrow keys, or clicking an edge hex; Proceed / F10
  confirms). A winner without one picks at random at once.
- Every unit is then auto-placed: spread evenly along its edge, nudged
  toward woods and rough and away from deep water, one 'Mech per hex.
- Only Player units can be moved or turned; persona units keep their
  auto-placed hex and facing. A Player unit may take any free hex on its own
  home edge, in any of the six facings. *Auto-place* re-places every Player
  unit; *Change edge* (Player winner only) clears edges and placements and
  reopens the choice.
- Done (F10) builds the units (`buildUnitInit` with the slot's skills,
  MaxHit and policy), creates the battle and rolls initiative for turn 1.

## Battle

The controller (`web/instant/battle/controller.ts`) runs the engine's
`gameLoop` with the engagement mode as its stopper (the engine never decides
the winner). Each prompt names the acting unit; a persona unit is played by
the AI, a Player unit waits for orders. Phases auto-advance as in the
terminal: movement, attack (weapons and physical attacks in one activation),
heat, end, next turn.

### Movement orders

The movement choices offered are only those legal for the actor now
(terminal `mode …` forms in brackets):

| unit state | choices |
|---|---|
| standing | Stand still, Walk, Run, Jump (with jump MP), Drop prone + turn, Drop prone (`prone [turn\|pronestill]`, with walk MP ≥ the drop cost), Shut down, Eject |
| prone | Turn (prone), Stay prone, Stand up / Stand up + walk / Stand up + run (not with a destroyed gyro or no walk MP; no run with a destroyed leg), Shut down, Eject |
| immobile, both legs gone, or one leg and both arms gone | Stand still or Stay prone, Shut down, Eject |
| shut down by choice | Start up, Abandon (house rule), Eject |
| shut down by heat | Abandon, Eject (restart is rolled in the heat phase) |

Shut-down units still move first, regardless of initiative (engine rule, as
in the terminal). Each choice shows its MP budget after any posture cost.

- Choosing Walk / Run / Jump / a stand-up or prone move shows every
  reachable landing (`reachableLandings`) on the map, with the cheapest MP
  cost per hex. Clicking the facing wedge of a landing hex picks that hex and
  facing; a hex with a single landing is picked by any click, otherwise a
  popup lists the facings reachable there with MP and any charge / DFA.
- **Charge / DFA** are declared as in the terminal: a Walk / Run (charge) or
  Jump (DFA) landing on an enemy hex stops in the hex before it; the landing
  says so. Only legal declarations are offered.
- Done (D or F10) commits once a stationary choice is made or a landing is
  picked: the posture change first, then the move, as the terminal's `done`
  (`executePostureMove`; a failed stand discards the move). A shut-down or
  unconscious unit's Done passes. Esc clears the draft.

### Attack orders

- **Target** — the fireable targets come from `suggestFireTargets` for the
  current twist; the best one is preselected. Tab / Shift+Tab cycle them, or
  click a target unit on the map. One target per activation, as in the
  terminal (TW p. 108 multi-target fire stays engine-only).
- **Twist** — Front / Left / Right (T cycles; terminal `torso`). Changing it
  drops weapon checks the new twist cannot fire.
- **Weapons** — one row per weapon with TN, hit chance, damage and heat;
  weapons that cannot fire show their reason (jammed, destroyed, out of
  range, no arc, no LOS, no ammo, auto-miss, prone, sensors out, club held,
  leg in cover). Checking a weapon validates the whole declaration with the
  engine, so illegal combinations (e.g. a prone unit mixing prop arms) are
  refused. A checks every weapon the declaration allows, N clears.
- **Physical attacks** — punch (each arm), kick (each leg), club and strike
  (per physical weapon) against every adjacent targetable unit, with TN and
  damage, when the engine validates them for the current twist. One type per
  turn, except both punches (TW p. 144).
- **Clubs** — Pick up (limb, tree, girder, when legal) excludes every other
  attack that turn (TW p. 146); Drop the club clears the weapon and physical
  checks.
- Done (D, F10 or Enter) runs `declareAttacks`; an empty draft passes.
  Resolution is simultaneous once the phase's last unit has declared, and the
  log fills with the results.

### Policies

The acting Player unit's policies (ammo, auto-eject, flamer heat, AMS) can be
changed during its prompt, as the terminal's `policy`; they take effect as
described there.

### Information

- **Log** — every game event, formatted from its structured fields into the
  current language (initiative, moves, to-hit rolls, hits and misses, AMS,
  piloting rolls, falls, pilot hits, heat, shutdowns, ammo explosions,
  removals, wreckage, building collapses, club handling).
- **Record sheets** — any unit's sheet (click it on the map, or open the
  left / right sheet): armor and internal structure, weapons, critical slots,
  heat, pilot. Hovering the pilot, engine, gyro, sensors, life support or
  heat explains what the current value costs now and what the next step adds,
  with the 2D6 roll and its chance (TW pp. 41–42, 60, 125, 159–160).
- **Action order** — the actor queue for the current phase.
- **Engagement status** — Annihilation shows units left per side, Attrition
  the damage race.

### Persona players

Persona units are played by a copy of the terminal's persona player
(`web/instant/ai/`; scoring as in [PERSONA.md](PERSONA.md)). Its decision is
applied through the same controller calls a Player uses, so atomic commits
apply. A persona command that fails is logged and the unit passes, so the
battle never stalls. Persona pace (New Battle, or the battle menu):
**instant**, **step** (default; Space plays the next persona activation) or
**timed** (about 0.6 s per activation). The choice is kept in localStorage
(`bt10x.instant.pace`).

### Battle menu

Esc opens it: Resume, Persona pace (cycles instant / step / timed), Withdraw
to setup (confirm; the battle is discarded). There is no undo. Persona play
holds while the menu (or its Withdraw confirm) is open and resumes when it
closes.

## Victory

| mode | ends | winner |
|---|---|---|
| Annihilation (`destroyAll`; Standup Fight, TW p. 259) | when one side has no unit left in play (destroyed, or removed: ejected, killed, abandoned hull) | the side with units left; both gone at once is a draw |
| Attrition (`damageRace`, turn limit N) | after turn N's end phase, or earlier on Annihilation's condition | the side that dealt more damage; ties go to the higher TW p. 257 BV score (`scoreReport`), then a draw |

Damage dealt by a side = the armor + internal structure points the opposing
units have lost since the start, read from unit state; every source counts
(weapons, physical attacks, falls, ammo explosions). A destroyed unit, or one
left as a hull, counts its whole armor + structure total. The mode names are
the app's own (TW p. 257 names none); the loadout keeps the ids
`destroyAll` / `damageRace`.

## Debrief

A verdict (side victory or draw, mode, map, the turn it ended, why), one line
per side (units lost, damage dealt, BV score), then:

| section | content |
|---|---|
| Result | why the side won (last unit out, damage totals, BV tiebreak or tie); the MVP (on the winning side, or either side in a draw: most kills, then most damage dealt, then hit rate); the TW p. 257 BV score worked out per unit |
| Units | per unit: pilot, skills, BV and lost share, kills and assists (engine kill credit), damage dealt and taken, peak heat and shutdowns, internal structure / armor / rear armor per location, critical hits |
| Fires | per unit: shots, hits, hit %, damage dealt and taken, kills, peak heat, ammo spent; the picked unit's weapons with their best hit |
| Timeline | damage each side dealt per turn, the swing turn, and key moments: first blood, falls, heat shutdowns, ammo explosions, pilots knocked out or killed, ejections, abandonments, units destroyed and by whom |
| Salvage | `salvageReport`: per hull and wreck, the intact weapons, ammo and systems |
| Map | the board as the battle ended: units in play, hulls, wrecks at each destroyed unit's last hex, wreckage terrain, severed limbs and clubs |
| Log | the battle log |

The fire statistics, damage per turn and key moments are folded from each
batch of game events as the battle runs (`web/instant/battle/chronicle.ts`);
the events are not kept.

**Rematch** (after a Yes / No confirm) rebuilds the battle from the same
loadout, deployment and seed: the same orders replay the same battle.

**Edit battle setup** (after a Yes / No confirm) leaves the debrief for New
Battle with the same loadout (sides, map, mode) to change; the debrief cannot
be reopened. *New battle* on the title starts from an empty loadout instead.

**Debrief menu** (Esc) holds the debrief's actions, which have no shortcut
keys: Close, Rematch, Edit battle setup, Back to title. ↑ ↓ pick,
Enter or Space run, Esc close.

## Controls

Mouse first; everything except picking a hex also works from the keyboard.

| scope | keys |
|---|---|
| Title | ↑ ↓ select, Enter run |
| New Battle | Tab / Shift+Tab move focus (kept inside an open dialog), Enter / Space press, ↑ ↓ open a dropdown, F10 launch, Esc close dialog / title |
| Choose 'Mech | `/` search, ↑ ↓ PgUp PgDn Home End move, Enter use, T tech, K pack, E era, S sort, Esc cancel |
| Deployment (edge) | ↑ → ↓ ← pick North / East / South / West, F10 proceed, Esc discard |
| Deployment (units) | ↑ ↓ select unit (centres the map on it), ← → turn a Player unit, F10 done, Esc discard |
| Battle, any prompt | Esc battle menu, `[` / `]` left / right record sheet, L log, Space next persona activation (step pace) |
| Movement | ↑ ↓ choice, Enter / Space choose (again: commit), D / F10 done |
| Attack | Tab / Shift+Tab target, T twist, ↑ ↓ row, Space toggle row, A all, N none, X jump to physical / club rows, D / F10 / Enter done |
| Debrief | `[` / `]` previous / next section, ↑ ↓ unit, PgUp PgDn scroll, Esc menu (↑ ↓ pick, Enter / Space run) |

**Map view** (setup preview, deployment, battle, debrief): drag to rotate,
wheel to zoom about the cursor, middle-drag to pan; on the north indicator,
left click north-up, middle click fit, right click turn +60° (Shift −60°),
wheel tilt (5°–90°). Hovering a hex shows its coordinates; in battle and on
the debrief map, a hex holding severed limbs or dropped clubs tips what lies
there.

**Font size** is the player's (10–40 px, header A− / A+ / Fit, kept in
localStorage); a window resize never changes it.

## i18n

Own catalog in `web/instant/i18n/` (`en` canonical, `ko`; `kr` aliases `ko`),
compile-checked against `en`; no keys are shared with the terminal. Locale
precedence follows the site: `?lang=`, then localStorage `bt10x.lang`, then
English, so the landing page, terminal and Instant Action stay in step; the
header switch re-renders every screen. Engine error text stays English.

## Feature parity with the terminal

| terminal | Instant Action |
|---|---|
| `map`, `add`, `set`, `rm`, `seed`, `status` (setup) | New Battle options and dialogs; Deployment for position and facing |
| `start` | Launch → Deployment → Done |
| `pp <id> <persona>`, `pp setup` | Control per unit, Random battle |
| `pp go`, `pp trace`, `pp why` | Personas act automatically (Space in step pace); no reasoning display |
| `mode …`, `place`, `done`, `cancel` | movement choices, map pick + facing popup, Done, Esc |
| `torso`, `fire`, `candidate` | twist, weapon rows, target cycling |
| `punch`, `kick`, `club`, `strike`, `pickup`, `drop` | physical and club rows |
| `policy`, `heat`, `sheet` | policy dialog, record sheets and hover hints |
| `board`, `log` | the map is always shown; the log |
| `salvage`, `rematch`, `reset` | Debrief Salvage, Rematch, New battle |
| `info mech`, `info map` | Choose 'Mech, map dropdown with preview |
| `lang`, `ver` | header language switch, version in the header |
| `rollback`, replay block, `autoplay`, `info weapon`, `table` | not included (a battle with no Player units stands in for `autoplay`) |

## Architecture

    web/instant.html              page: TUI kit, instant.css, import map btlib10x → ./btlib10x.js, instant.js
    web/instant.css               layout, terrain and team colour tokens, the bt10x theme
    web/instant/instant.ts        boot: fetch catalogs, i18n, header, screen router, key dispatch
    web/instant/state.ts          shared app state (screen, loadout, deployment, battle, modals)
    web/instant/flow.ts           screen-to-screen flow: launch, deployment, battle start, persona pacing, rematch
    web/instant/screen.ts         fixed screen and font size
    web/instant/rng.ts            mulberry32-seeded Rng (copy of the terminal's)
    web/instant/setup/loadout.ts  pure loadout model: slots, validation, 'Mech filters, random sides, [+] picks
    web/instant/battle/
      controller.ts               owns BattleState + Rng + persona context + the actor's draft; atomic commits
      deploy.ts                   TW p. 256 roll-off, home edges, auto-placement
      victory.ts                  Annihilation / Attrition stoppers, tallies, battle result
      chronicle.ts                debrief record folded from game events
      log.ts                      GameEvent → localized log entries
    web/instant/ai/               persona player (copied from web/terminal/persona*.ts)
    web/instant/map/view.ts       vector hex map: canvas renderer, overlays, unit banners, hit testing
    web/instant/screens/          one module per screen (title, setup, deploy, battle, debrief) + shared parts
    web/instant/i18n/             string catalogs
    web/instant/maps/             Instant-Action-only map sources (see its README)

**Boundary.** Instant Action imports only `btlib10x` and `window.TUI`, never
`web/terminal/`. Logic it shares with the terminal (persona AI, RNG, victory
check, movement and attack draft rules) is a copy with the same behaviour,
not shared code and not moved into the engine. It typechecks against
`dist/`, so the stale-dist trap in AGENTS.md applies.

## Build, run, and ship

    npm run pack:ia        # web/instant/maps/*.json → web/instant/instant.jsonl (only if there are IA maps)
    npm run build:web      # also bundles web/instant/instant.ts → web/instant.js (engine external)
                           # and copies web/instant/instant.jsonl → web/btlib10x.ia.jsonl when present
    npm run dev:web        # watch + serve; Instant Action at /instant.html
    npm run dist:web       # ships instant.html, instant.css, instant.js (+ btlib10x.ia.jsonl when present)

At boot the app loads three packs: the base catalog, the SW season pack and
the Instant Action map pack (`appendCatalog(text, "ia")`). A failed SW fetch
degrades with a console warning; a missing IA pack is ignored. DOM-free logic
is covered by `tests/instant.test.ts`: deployment, victory modes, the debrief
record, the controller, setup, the record-sheet hints, the import boundary, and
a scripted battle that must end exactly as the terminal session playing the
same commands.
