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
  opens it in New Battle for review (it never starts the battle);
  *Options* opens the Options window (see "Options"). The title has no Esc
  menu.
- **New Battle** — edit the loadout; Launch (F10) goes to Deployment,
  Discard (button, or the Esc menu) asks first, then clears the setup and
  returns to the title.
- **Deployment** — roll-off for home edges, then placement; Done (F10)
  creates the battle. Discard (button, or the Esc menu) asks first, then
  returns to the title with the New Battle setup kept.
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
| Control | Player, or one of the seven personas, picked in the Choose Control dialog (a new slot gets a random persona, never Player) | `pp <id> <persona\|off>` |
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
a name search (model, chassis, Clan name) and dropdowns for weight class
(any, light, medium, heavy, assault), tech base (any, IS, Clan), pack (any,
base, sw), an era cap (intro year ≤ N, default 3150) and sort (tonnage,
name, BV, intro), with tech / pack / era on one row and the matched / total
count beside sort.
The selected 'Mech's summary shows class, tonnage, tech base, intro year,
BV, walk / run / jump, its weapons (location, ammo of the shared pool) and a
seven-row paper doll of internal structure and armor:

```
                [ H D ]            [HS]
                 3I/ 9A             -11
        [ R T ] [ C T ] [ L T ]
[ R A ]   15I     22I     15I   [ L A ]
11I/13A 14F/ 5R 16F/ 5R 14F/ 5R 11I/13A
        [ R L ]         [ L L ]
        15I/13A         15I/13A
```

(I internal, A armor, F / R torso front / rear, HS heat dissipation.)

### Choose Control

A slot's Control button opens it, an 80-column window in three rows:

1. The control list (Player and the seven personas; `•` marks the slot's
   current one) beside a scrolling description of the highlighted one: role
   line, how it plays and the stall-pressure note (docs/PERSONA.md §2.4, §7).
2. Move Weights and Settings, half the width each. Each weight is a kit
   progress bar, full at the largest value any persona gives that weight,
   with `value/max` beside it. Settings (range band, heat limit with its
   Heat Scale step, ammo discipline, melee preference, jump jets, when it
   yields) are read from the persona table and scroll when a value wraps.
   Weight labels and setting keys are hint targets: a tooltip says what each
   one does, on hover or when the arrow keys reach it (Tab skips them).
3. Cancel and Use.

Jump jets read "used" for both `reposition` and `hit-and-run`, which the AI
does not yet tell apart. Nothing changes until Use; closing either dialog
puts the focus back on the button that opened it.

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

- Deployment is one screen. If the roll-off winner's side has a Player unit,
  the side pane shows a *Home edge* dropdown that starts on *Not selected*;
  Done stays disabled (F10 says to choose an edge) until one is picked. A
  winner without one picks at random at once and the pane shows its choice.
- Picking or changing the edge sets both sides (the loser takes the opposite
  one) and auto-places every unit again, hand placements included; *Not
  selected* clears them and hides the unit list. Every unit is auto-placed: spread evenly along its edge, nudged
  toward woods and rough and away from deep water, one 'Mech per hex.
- Only Player units can be moved or turned; persona units keep their
  auto-placed hex and facing. A Player unit may take any free hex on its own
  home edge, in any of the six facings. *Auto-place* re-places every Player
  unit.
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
  cost per hex. A click (or A on the reticle) picks a landing hex and the
  facing wedge under the pointer, else the reachable facing nearest it; a
  further click on that hex steps to the next reachable facing clockwise
  (see Controls). A second row of the Movement Command box says what to do
  next ("click a tinted hex") or shows the picked landing (hex, facing,
  MP); the status bar holds only key hints.
- **Charge / DFA** are declared as in the terminal: a Walk / Run (charge) or
  Jump (DFA) landing on an enemy hex stops in the hex before it; the landing
  says so. Only legal declarations are offered.
- Done (F10) commits once a stationary choice is made or a landing is
  picked: the posture change first, then the move, as the terminal's `done`
  (`executePostureMove`; a failed stand discards the move). A shut-down or
  unconscious unit's Done passes. Backspace clears the landing; choosing
  another mode drops it too.

### Attack orders

The Attack Command panel holds selectors and two buttons, top to bottom:
Twist, Weapon Target, the weapons button, the physical attacks button, Club,
and the heat estimate. The cursor starts on the weapons button
(`web/instant/screens/battle.attack.ts`).

- **Twist** — shown Left / Front / Right, Front by default (← → on any row
  but Weapon Target and Club turn toward that side; Enter on the Twist row
  steps one to the right, round again; a click takes that twist; terminal
  `torso`). Changing it drops weapon and physical checks the new twist
  cannot make.
- **Weapon Target** — the fireable targets come from `suggestFireTargets`
  for the current twist; the best one is preselected. ← → on the row (or
  Enter there, or a click on it) cycle them, or click a target unit on the
  map. One weapon target per activation, as in the terminal (TW p. 108
  multi-target fire stays engine-only). Changing it clears the weapon checks
  only.
- **Weapons button** — "N selected out of M available weapons", hidden with
  no weapon target. Enter or a click opens the weapon dialog: one row per
  weapon with TN, hit chance, damage and heat, and a check box. A weapon that
  cannot fire shows its reason in place of those columns (jammed,
  destroyed, out of range, no arc, no LOS, no ammo, auto-miss, prone,
  sensors out, club held, leg in cover, or a checked physical attack using
  its limb: arm punches, arm strikes, leg kicks, club swing), and the cursor
  skips it. Checking a weapon validates the whole declaration with the
  engine, so illegal combinations are refused.
- **Physical attacks button** — "N selected out of M available physical
  attacks", shown when any is legal. Its dialog lists punch (each arm), kick
  (each leg), club and strike (per physical weapon) against every adjacent
  targetable unit, with a Target column (unit id, models on the legend line);
  attacks the engine refuses for the current twist are left out. One type per
  turn, except two punches, which may go to two different targets (TW
  pp. 144-145). An attack that conflicts with what is already checked shows
  why (one type only, one per turn, arm in use, arm fires, leg fires, arm guns
  fire) and the cursor skips it. The hex of the unit under the dialog cursor
  is outlined on the map.
- **Dialogs** — ↑ ↓ move through the rows that can be checked, Enter / Space
  (or a click) toggle one and move on to the next (A A A checks a volley);
  Esc / Backspace / F10, CLOSE or a click outside close the dialog. Checks
  apply as they are toggled.
- **Club** — shown when a club action is possible: none, pick up (limb,
  tree, girder, when legal) or drop the club; ← → or Enter cycle it. Picking
  up excludes every other attack that turn (TW p. 146), so both buttons go
  dim; dropping clears the weapon and physical checks.
- Done (F10) runs `declareAttacks`; with nothing checked it asks first
  (Pass? Yes / No, No by default), then an empty draft passes.
  Resolution is simultaneous once the phase's last unit has declared, and the
  log fills with the results.

### Policies

The acting Player unit's policies (ammo, auto-eject, flamer heat, AMS) can be
changed during its prompt, as the terminal's `policy`, from the policy
button on its record sheet or *Policies* in the battle menu (OK, Cancel
or Esc go back to the menu); they take effect as described there.

### Information

- **Log** — every game event, formatted from its structured fields into the
  current language (initiative, moves, to-hit rolls, hits and misses, AMS,
  piloting rolls, falls, pilot hits, heat, shutdowns, ammo explosions,
  removals, wreckage, building collapses, club handling).
- **Record sheets** — any unit's sheet (click it on the map, or open the
  left / right sheet): armor and internal structure, weapons, critical slots,
  heat, pilot. Each new actor, Player or persona alike, resets the drawers:
  in the movement phase the left one shows the mover and the right one
  closes; in the attack phase the right one shows the weapon target (a new
  target updates it) and the left one closes. Manual opens, closes and
  picks hold until then. While a map clip plays the drawers follow the clip,
  not the prompt waiting after it (see Camera). The header's `S1: A1 ▼` picks the unit; its pin
  (`◇` / `◆` pinned, on the map side of the header, or Shift+`[` / `]`) keeps that drawer as it is
  through the policy (a map or queue click meant for it uses the other one).
  Hovering the pilot, engine, gyro, sensors, life support or
  heat explains what the current value costs now and what the next step adds,
  with the 2D6 roll and its chance (TW pp. 41–42, 60, 125, 159–160).
  Hovering HS lists the heat sinks: operational / total and type, the ones
  the engine holds, the crit-slot ones intact / total, then each crit-slot
  sink as `CT#11` (a double sink as its slot run). Location and HS tips
  colour each filled crit slot the same way: white intact, gray (as lost
  armor) destroyed by a critical hit (a hit taken before the location was
  lost stays gray), orange lost with its location. An ammo bin's shot count (`24/24`) takes
  the armor and internal structure level colours instead.
- **Action order** — the actor queue for the current phase.
- **Engagement status** — Annihilation shows units left per side, Attrition
  the damage race.

### Persona players

Persona units are played by a copy of the terminal's persona player
(`web/instant/ai/`; scoring as in [PERSONA.md](PERSONA.md)). Its decision is
applied through the same controller calls a Player uses, so atomic commits
apply. A persona command that fails is logged and the unit passes, so the
battle never stalls. Persona pace (New Battle, the battle menu or Options):
**instant**, **step** (default; Enter / Space / A, or the NEXT PERSONA
button in the DONE button's place, plays the next persona activation, even
with the reticle showing) or
**timed** (about 0.6 s per activation). The choice is kept in localStorage
(`bt10x.instant.pace`).

### Options

The title menu's *Options* and the last row of every Esc menu (New Battle,
Deployment, Battle, Debrief, under a separator) open it. Three rows:
**Language** (English / 한국어, the same switch as the header buttons),
**Persona pace** (above) and **Persona reasoning log** (off by default, kept
in localStorage `bt10x.instant.reasoning`: `on` / `off`). With the log on,
each persona decision adds a dim battle-log line: unit, persona, posture,
the top-scored choice and how many candidates were weighed. ↑ ↓ pick a row,
← → step its value either way, Enter / Space (or a click on the row) step it
forward, a click on ◀ / ▶ steps that way; a change applies and is kept at
once. Esc / Backspace close it, back to the menu that opened it on its
Options row (from the title, back to the title menu on Options). In battle,
persona play stays on hold until the battle menu itself closes.

### Map animations

The map replays each committed step after the engine has applied it
(`web/instant/battle/beats.ts` reads the step's game events and the committed
move; `web/instant/map/anim.ts` plays them). Presentation only: state, dice
and the log are final at once; the map's banners catch up beat by beat.

- **Acting unit**: a dashed ring inside its hex in the team colour, the dashes
  marching round (about 30 frames a second); when the turn passes to another
  unit, a ring grows out of the new actor's hex once (450 ms).
- **Movement**: the unit slides along the path it actually took, hex by hex
  (walk 160 ms a hex, run 110 ms, 90 ms a 60° turn; a move never takes more
  than 1.6 s), leaving fading footprints (three a hex when running). A jump
  arcs straight to the landing with the triangle as a ground shadow and a
  dust ring on touchdown (300 ms + 60 ms a hex). A move cut short by a fall
  stops where the unit fell.
- **Attack reel**: attacks resolve together at the phase's end, so the map
  plays one volley per attacker and target in event order: weapons fire
  110 ms apart (closer for big volleys; a volley ≤ 1.5 s); energy weapons
  draw a beam, ballistic a shell, missiles a spread of four. A hit sparks,
  flashes the hex, shakes the sign and drops its armor pips, and adds a
  ticker line beside the sign (`−5 CT`, `✶CRIT` in orange); a miss veers
  past the target as a dim dashed line and ticks MISS (or JAMMED). Physical
  attacks lunge at the target with the attack named over the attacker; self
  damage ticks on the attacker. AMS ticks on the defender.
- **Penalties**: a piloting roll shows a chip over the sign (`PSR 7+ · 9 ✓`
  green, ✗ red; a pass wobbles the sign); a fall drops the pole, tips the
  sign, turns the triangle to the new facing and ticks FALL; pilot hits tick
  PILOT +n (KO on a failed consciousness roll); an ammo explosion throws two
  orange rings; heat shutdown, hulls and destroyed units show on the sign.
- **Pace**: timed waits for the clip, then 0.6 s; step plays it after Enter;
  instant skips persona moves and plays the attack reel at Fast. Player moves
  always play. Persona play holds while a clip runs.
- **Skip**: Enter / Space / F10 / Backspace (pad A, Y, B) or a press on the
  map while a clip plays end it at once (the map jumps to the result) and do
  nothing else, so a press meant for the next prompt never lands on the old
  one. Esc opens the battle menu and pauses the clip until the menu closes
  (Options and Policies opened from it keep it paused); Animations set to Off
  there ends it. L, Tab, `[` / `]`, zoom, pan, turn and frame (PgUp / PgDn,
  Shift+arrows, Shift+PgUp / PgDn, Home) work during a clip without ending
  it; any other key is ignored until it ends. With a dialog open, keys go to
  the dialog.
- **Orders panel**: while a clip plays it says what the map shows (`A1
  acting…`, `Resolving attacks…`, with `(paused)` while the battle menu is
  open) instead of the prompt already waiting; a move or jump clip shows no
  box (the map shows it), except `A1 moving… (paused)` / `A1 jumping…
  (paused)` while paused. A SKIP button and only Enter Skip / Esc Menu in
  the status bar stand in for the prompt; the next prompt comes back when the clip ends or is skipped.
- **Setting**: Animations in the battle menu, Full / Fast (half the time) /
  Off, kept in localStorage (`bt10x.instant.anim`); Fast by default when the
  OS asks for reduced motion, which also turns travel, shakes and rises into
  cuts and short fades, and stills the marching ring.

### Camera

Every map clip and prompt has a set of spots it must show whole: each hex of
a move with the sign above it (a jump also its arc's headroom), the attacker
and target of every volley or physical attack with the target's ticker
column, and a unit's sign and chip for piloting rolls, falls, pilot hits,
ammo explosions, shutdowns and removals (`web/instant/battle/camera.ts`).
They must fit the clear part of the canvas: the canvas clipped to the
browser window, less the boxes of every overlay over it (open drawers, edge
tabs, the orders or clip-status box, DONE / SKIP, the LOGS tab), measured
after the render.

- **The action wins.** While a clip plays the HUD shows the clip: a move,
  jump or one unit's clip puts that unit in the left drawer and closes the
  right one; the attack reel closes both. The next prompt's drawers and
  framing apply when the clip ends or is skipped. Pinned drawers stay as they
  are.
- **Least camera move** (`MapView.ensureVisible`), before the clip starts:
  already shown, no move; else the shortest pan; else zoom out about the
  spots, down to a map font size of 9 (or the whole-map fit, if that is
  smaller); else the unpinned drawers close for the clip; else the nearest
  30° turn that fits. The camera glides over 250 ms and the clip waits for it
  (a cut under reduced motion).
- **Big reels**: when the attack reel cannot show whole even so, the camera
  follows it, framing each attack (attacker and target) in turn with the same
  steps, 250 ms before each.
- **Prompts**: a mover is fitted with its enemies (a Player's move also with
  every hex it can reach), a Player's shot frames shooter and target as
  before, and a persona's shot moves the camera only as far as it takes to
  show both. All use the measured clear area.
- A view moved by hand holds until the next actor; clips still move it, but
  only as little as it takes to show them.

### Battle menu

Esc opens it: Resume, Persona pace (Enter or → cycles instant / step /
timed, ← the other way), Animations (full / fast / off, the same keys),
Policies (while a Player unit acts), Withdraw to
setup (confirm; the battle is discarded), then Options under a separator.
There is no undo. Persona play
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
keys: Rematch, Edit battle setup, Back to title. ↑ ↓ pick,
Enter or Space run, Esc or Backspace close.

## Controls

One scheme for keyboard, Xbox pad and mouse (`web/instant/input.ts`). Enter /
Space select or go on and can be undone; F10 (or Shift+Enter / Shift+Space)
commits and cannot; Backspace cancels or steps back; Esc closes the open
dialog, else opens the screen's menu; `[` / `]` step tabs or groups. The pad
is polled through the Gamepad API (standard mapping); its buttons are sent as
these keys to the focused element, so kit popups and dialogs take them too.

| key | pad | mouse | does |
|---|---|---|---|
| ↑ ↓ ← → | D-pad | – | move the cursor; ← → also twist (attack) and turn (deployment) |
| Enter, Space | A | left click | select / toggle / next (reversible) |
| F10, Shift+Enter, Shift+Space | Y | Launch / Done | commit (no going back) |
| Backspace | B | Cancel | cancel, back one step; Esc in a kit dialog or popup |
| Esc | Menu | `Esc` hint | close the dialog, else open / close the menu |
| `[` / `]` | LB / RB | sheet tabs, tab labels | previous / next tab or group |
| Tab / Shift+Tab | X | – | next / previous field; in battle, the key focus |
| PgUp / PgDn | LT / RT | wheel | page a list or scroll; on a map screen, zoom; with the battle log open, page it |
| L | View | LOGS tab | toggle logs |
| Shift+arrows | left stick | middle drag | pan the map under the centre reticle |
| Shift+PgUp / Shift+PgDn | right stick | left drag, indicator wheel | turn the map counter-clockwise / clockwise (keys: like Shift+arrows, it speeds up while held); the stick and wheel also tilt |
| – | L3 | indicator left click | snap to the nearest 60°; on a step, +60° |
| Home | R3 | indicator middle click | frame the map: in battle the units the prompt is about, again the whole map; elsewhere the whole map |

Commit buttons (Launch, Done) take F10 or a click only: Enter on a
focused one does nothing. Hover never moves a cursor. Right click does nothing
on the map. In a text box only Enter, Esc, ↑ ↓ and Tab act; Shift+Space types a
space there; pad B leaves the box (a pad cannot type).

| scope | keys |
|---|---|
| Title | ↑ ↓ select, Enter run (New battle, Random battle, Options); no Esc menu |
| New Battle | arrows move to the nearest control (dropdowns too; Enter opens one to change it), `[` / `]` Side 1 / Side 2 / settings, Enter open, F10 launch, Esc menu (Launch, Discard, Options) |
| Choose 'Mech | opens on the list (its cursor row is the one Tab stop); list: ↑ ↓ PgUp PgDn move, Enter / Space use, ↑ past the first row to the filters, → to Use; on a dropdown, the search or a button, arrows move to the nearest control (the list's cursor row too; Enter opens a dropdown); in the search ↑ ↓ leave it, Enter goes to the list; Tab / Shift+Tab cycle the dialog; Esc / Backspace cancel |
| Choose Control | opens on the list at the slot's current control; ↑ ↓ move (the detail follows), PgUp / Home first, PgDn / End last, Enter / Space / double-click use, → to Use; on a button or a hint target, arrows move to the nearest control (the weight labels and setting keys too, which show their tooltip while focused; ← back to the list); Tab / Shift+Tab cycle the dialog; Esc / Backspace cancel |
| Deployment | Home edge dropdown: Enter opens it, arrows leave it like any control; unit list: ↑ ↓ select unit (centres the map on it), past the ends to the nearest control, ← → turn a Player unit; on a button, arrows move to the nearest control; Backspace pick the unit up, F10 done (once an edge is set), Esc menu (Done, Discard, Options) |
| Battle, any prompt | Esc battle menu, Tab / Shift+Tab (X) key focus: left sheet (its closed tab when shut), orders, right sheet (its closed tab), wrapping; `[` / `]` open / close the left / right record sheet (closing the focused one hands the focus to the orders), Shift+`[` / `]` pin / unpin it, L log, Enter / Space next persona activation (step pace; ignored for 300 ms after control returns, and on key repeat); while a map animation plays, Enter / Space / F10 / Backspace or a press on the map only skip it, Esc opens the menu and pauses it, view keys work and other keys are ignored |
| Battle, a sheet focused | arrows move to the nearest hint target that way (header, pin, pilot hits, policy, engine, gyro, sensors, life support, location names, HS, heat; its tip shows), Enter / Space on the header open the unit picker, on the pin toggle it, on the policy button (acting Player unit) the policy dialog, on a closed tab open the sheet; Backspace focus back to the orders; F10 still commits |
| Movement | ← → along the mode bar; on Hold, Enter / Space open its dropdown on the held choice, ↓ / ↑ open it one choice after / before it, round the list (nothing held: ↓ the first, ↑ the last); Enter / Space on a mode choose it (another mode drops the landing); Backspace clear the landing, F10 done. While a record sheet has the focus, the orders cursor dims to the sheet header's green |
| Attack | ↑ ↓ Twist, Weapon Target, weapons button, physical attacks button, Club (hidden and dim rows skipped); ← → previous / next target on Weapon Target, previous / next action on Club, else twist; Enter / Space step the twist, next target or club action, or open the button's dialog; F10 done (with nothing checked, a Pass? confirm) |
| Attack dialog | ↑ ↓ rows that can be checked; Enter / Space toggle the row and move on to the next (A A A checks a volley); Esc / Backspace / F10 close, the checks kept |
| Debrief | `[` / `]` previous / next section, ↑ ↓ unit, PgUp PgDn scroll, Esc menu (Rematch, Edit battle setup, Back to title, Options; ↑ ↓ pick, Enter / Space run) |
| Options | ↑ ↓ row, ← → step the value, Enter / Space step it forward, Esc / Backspace back to the opener |
| Menus, dialogs | opening one takes the focus off the control behind it; ↑ ↓ / Tab move, Enter / Space run, Esc / Backspace close; a message closes on Enter, Space, Esc or Backspace. A dialog opened from a control gives the focus back to it on closing. The Esc menus end with Options, under a separator |

**Picking a hex.** A click on a banded hex (a landing, a deployment hex)
takes the available facing triangle under the pointer, else the available
facing nearest the pointer; a further click on the hex where a facing is
already chosen steps to the next available facing clockwise. No facing popup
opens on the map; the hovered hex lights the triangle a click would take.
With the pad (or Shift+arrows) a reticle marks the centre of the clear map
area; the left stick pans the map under it, and A there is that same click at
the reticle's point (not while a persona waits in step pace: A plays it).
Shift+arrows move like a platform game hero: no jump on the press; the
reticle sets off at 40 px/s and speeds up, slowly at first, to the stick's
700 px/s over 1 s, so a tap moves it a few pixels; let go, it skids to a
stop in 0.15 s; two arrows go diagonally. Shift+PgUp / Shift+PgDn turn the map the same way: 8°/s at first, up to the
stick's 120°/s over 1 s, slowing to a stop in 0.15 s. The hex under the reticle is highlighted and tips its
piles. A D-pad press or plain arrow hands A back to the orders panel; any
mouse movement hides the reticle.

**Map view** (setup preview, deployment, battle, debrief): drag to rotate,
wheel to zoom about the cursor, middle-drag to pan; on the north indicator,
left click snaps to the nearest 60° (again: +60°), middle click fits, wheel
tilts (5°–90°). Each screen may set an initial view (`SCREEN_VIEWS` in
`web/instant/flow.ts`: rotation, tilt, fit), applied when it first shows the
map after another screen did: New Battle, deployment and the debrief start
fitted at 45° rotation, 25° tilt; battle has none and keeps the view as deployment left it.
Hovering a hex shows its coordinates; in battle and on the
debrief map, a hex holding severed limbs or dropped clubs tips what lies
there.

**Status bar.** The battle status bar names pad buttons (A, B, X, Y, LB,
RB, View, Menu, D-pad, LS) after pad input, and keys again after a key or a
mouse move.

**Font size** is the player's (10–40 px, header A− / A+ / Fit, kept in
localStorage `bt10x.ia.fontSize`). Fit is a mode, stored as `fit` and shown
lit: the size is fitted again on every load and window resize. A− / A+
leave it and store a fixed size, which a resize never changes. A first
visit starts in Fit mode.

## i18n

Own catalog in `web/instant/i18n/` (`en` canonical, `ko`; `kr` aliases `ko`),
compile-checked against `en`; no keys are shared with the terminal. Locale
precedence follows the site: `?lang=`, then localStorage `bt10x.lang`, then
English, so the landing page, terminal and Instant Action stay in step; the
header switch (or Options' Language row) re-renders every screen. Engine error text stays English.

## Feature parity with the terminal

| terminal | Instant Action |
|---|---|
| `map`, `add`, `set`, `rm`, `seed`, `status` (setup) | New Battle options and dialogs; Deployment for position and facing |
| `start` | Launch → Deployment → Done |
| `pp <id> <persona>`, `pp setup` | Control per unit, Random battle |
| `pp go`, `pp trace`, `pp why` | Personas act automatically (Enter / Space in step pace); Options' Persona reasoning log shows each decision's pick (no full `pp trace`) |
| `mode …`, `place`, `done`, `cancel` | movement choices, map pick + facing, Done, Backspace |
| `torso`, `fire`, `candidate` | twist, weapon rows, target cycling |
| `punch`, `kick`, `club`, `strike`, `pickup`, `drop` | physical and club rows |
| `policy`, `heat`, `sheet` | policy dialog, record sheets and hover hints |
| `board`, `log` | the map is always shown; the log |
| `salvage`, `rematch`, `reset` | Debrief Salvage, Rematch, New battle |
| `info mech`, `info map` | Choose 'Mech, map dropdown with preview |
| `lang`, `ver` | header language switch, Instant and engine versions in the header (see "Versioning" in `AGENTS.md`); the header MOTD button opens `web/instant/MOTD.txt` as on the terminal page |
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
      controller.ts               owns BattleState + Rng + persona context + the actor's draft; atomic commits; `onStep` per commit
      beats.ts                    map animation beats from a step's game events and committed move; timing
      deploy.ts                   TW p. 256 roll-off, home edges, auto-placement
      victory.ts                  Annihilation / Attrition stoppers, tallies, battle result
      chronicle.ts                debrief record folded from game events
      log.ts                      GameEvent → localized log entries
    web/instant/ai/               persona player (copied from web/terminal/persona*.ts)
    web/instant/map/view.ts       vector hex map: canvas renderer, overlays, unit banners, hit testing, poses and effect layers
    web/instant/map/anim.ts       map animation clips: tweens and banner changes from beats, skip, hand-off ring
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
