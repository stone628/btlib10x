/**
 * Canonical message catalog. Every other locale must implement `Catalog`
 * (i.e. provide exactly these keys), making missing translations a
 * compile-time error. Values may contain `{param}` placeholders filled by t().
 */
export const en = {
  // app chrome
  "app.banner.title": "btlib10x terminal - Classic BattleTech quick-start rules",
  "app.banner.help": "type 'help' for commands.",
  "err.prefix": "error:",

  // per-state hints (multi-line)
  "hint.setup":
    "you are in 'setup' phase.\nload a battlefield via 'map' and place mechs via 'add'.\nreview the roster via 'status', remove mistakes via 'rm', then begin with 'start'.",
  "hint.move":
    "you are in the movement phase - the prompt shows whose turn it is.\ndeclare a speed via 'mode', then queue steps via 'move' or 'face'; check MP costs with 'status'.\ncommit the move with 'done', or discard it with 'cancel'.",
  "hint.attack":
    "you are in the weapon attack phase - the prompt shows who is firing.\nbrowse the acting unit's guns via 'weapons', then declare shots against one target via 'fire'.\nreview the declaration with 'status', resolve with 'done', or discard it with 'cancel'.",
  "hint.over":
    "the battle is over.\nreplay the same roster and seed with 'rematch', or return to an empty setup with 'reset'.",

  // board
  "board.noMap": "no battlefield yet - load one via 'map'; 'info map' lists the choices.",

  // lang command
  "lang.current": "language: {locale}",
  "lang.available": "available: {list}",
  "lang.set": "language set to {locale}",
  "err.unknownLocale": "unknown locale '{name}' (available: {list})",

  // help machinery
  "help.usagePrefix": "usage: ",
  "help.argumentsHeader": "arguments:",
  "err.unknownCommand": "unknown command '{name}' (try 'help')",

  // generic argument parsing
  "err.notInteger": "{label} must be an integer",
  "err.oneBased": "{label} is 1-based and must be >= 1",
  "err.expectedArgs": "usage: {usage}",

  // command help texts
  "cmd.help.help": "list commands for the current state, or detail one command",
  "cmd.q.help": "alias for help",
  "cmd.lang.help": "show or switch the output language",
  "cmd.lang.arg.locale": "locale code; omit to show the current language",
  "cmd.board.help": "draw the ASCII battle grid",
  "cmd.clear.help": "clear the scrollback screen",
  "cmd.log.help": "show last N events (default 10)",
  "cmd.log.arg.n": "how many recent events to show (default 10)",
  "cmd.info.help": "look up 'Mech models or bundled maps",
  "cmd.info.arg.mech": "model key like HBK-4G; omit to list all models",
  "cmd.info.arg.map": "bundled map name; omit to list maps",
  "cmd.sheet.help": "record sheet for a unit",
  "cmd.sheet.arg.id": "unit id (placed unit in setup, any unit in battle)",
  "cmd.sheetActing.help": "record sheet of the acting 'Mech",
  "cmd.seed.help": "set the dice seed",
  "cmd.seed.arg.n": "integer seed; the same seed reproduces the same rolls",
  "cmd.reset.help": "wipe everything back to empty setup",
  "cmd.map.help": "load a bundled rulebook map (beginner|quickstart)",
  "cmd.map.arg.name": "bundled map name: beginner | quickstart",
  "cmd.add.help": "place a 'Mech on the map",
  "cmd.add.arg.id": "unique unit id used by later commands",
  "cmd.add.arg.model": "'Mech model key, see 'info mech'",
  "cmd.add.arg.team": "team number (0 or 1)",
  "cmd.add.arg.gunnery": "pilot gunnery skill; lower is better",
  "cmd.add.arg.colrow": "target hex, 1-based, must be inside the map",
  "cmd.add.arg.facing": "optional facing n|ne|se|s|sw|nw (default n)",
  "cmd.rm.help": "remove a placed unit",
  "cmd.rm.arg.id": "id of a previously added unit",
  "cmd.statusSetup.help": "setup summary: units grouped by team, selected map",
  "cmd.start.help": "start the battle (needs >=2 units on >=2 teams)",
  "cmd.mode.help": "declare movement mode",
  "cmd.mode.arg.mode": "standstill | walk | run | jump; each has its own MP pool",
  "cmd.move.help": "queue a step into an adjacent hex",
  "cmd.move.arg.colrow": "adjacent destination hex, 1-based",
  "cmd.face.help": "queue a facing change",
  "cmd.face.arg.facingsteps":
    "absolute facing word, or relative turn of -5..5 hex sides; each side costs 1 MP",
  "cmd.statusMove.help": "queued move steps with running MP cost per step",
  "cmd.cancelMove.help": "clear mode and queued steps",
  "cmd.doneMove.help": "commit the declared move",
  "cmd.weapons.help": "list a unit's weapons (default: acting unit)",
  "cmd.weapons.arg.id": "unit to inspect; defaults to the acting unit",
  "cmd.fire.help": "queue a weapon attack",
  "cmd.fire.arg.weaponIndex": "index from the 'weapons' listing",
  "cmd.fire.arg.targetId": "enemy unit id; all shots must share one target",
  "cmd.fire.arg.shots": "optional shot count for multi-shot weapons (SRM/LRM)",
  "cmd.statusAttack.help": "queued attack declarations",
  "cmd.cancelFire.help": "clear queued shots",
  "cmd.doneFire.help": "declare attacks and resolve them",
  "cmd.rematch.help": "new battle with the same roster, terrain and seed",

  // autoplay demo driver (hidden command, not listed in help)
  "autoPlay.started":
    "autoplay: building a demo battle and playing both sides; type any command to take over.",
  "autoPlay.done": "autoplay finished.",

  // command acknowledgements
  "ok.mapLoaded": "map {name}: {w}x{h}, {n} terrain hexes",
  "ok.added": "{id} ({model}) placed at ({col},{row}) facing {facing}",
  "ok.removed": "removed {id}",
  "ok.started": "battle started",
  "ok.modeDeclared": "{id} declares {mode}",
  "ok.stepQueued": "queued step to ({col},{row})",
  "ok.turnQueued": "queued facing change {steps}",
  "ok.cancelled": "cancelled",
  "ok.fireQueued": "queued #{index} -> {target}{suffix}",
  "ok.seedSet": "seed set to {seed}",
  "ok.resetDone": "reset.",
  "ok.rematchDone": "rematch!",
  "banner.draw": "=== DRAW - NO UNITS REMAIN ===",
  "banner.win": "=== TEAM {team} WINS ===",

  // setup/session errors
  "err.unknownMap": "Unknown map {name}; available: {list}",
  "err.unknownModel": "Unknown 'Mech model: {model} (try 'info mech')",
  "err.duplicateId": "Duplicate unit id: {id}",
  "err.badTeam": "team must be a non-negative integer",
  "err.badGunnery": "gunnery must be an integer 0..7",

  // pilot experience bands (gunnery 0..7, lower is better)
  "skill.elite": "Elite",
  "skill.veteran": "Veteran",
  "skill.regular": "Regular",
  "skill.green": "Green",

  "err.hexOccupied": "Hex {col},{row} already occupied",
  "err.noSuchUnit": "No such unit: {id}",
  "err.alreadyStarted": "Battle already started",
  "err.needTwoUnits": "A battle needs at least two units",
  "err.needTwoTeams": "Units must span at least two teams",
  "err.badModeWord": "mode must be one of standstill|walk|run|jump",
  "err.noBattle": "No active battle",
  "err.wrongPhase": "Command requires the {phase} phase",
  "err.declareModeFirst": "Declare a movement mode for {id} first (mode walk|run|jump|standstill)",
  "err.sameHexMove": "Must move to a different hex",
  "err.alreadyThere": "Already at that hex",
  "err.standStillNoEnter": "Standing still forbids entering hexes",
  "err.jumpNotAdjacent": "Jump steps must enter an adjacent hex",
  "err.groundStraightOnly":
    "Ground moves must go straight ahead or straight back relative to facing",
  "err.standStillNoFace": "Standing still forbids facing changes",
  "err.jumpFreeFacing": "Jumping 'Mechs choose facing freely on landing; no turn steps",
  "err.badFacings": "Facing change must be 1..5 hexsides in either direction",
  "err.faceArg": "face expects a facing ({facings}) or ±1..5 steps",
  "err.faceCurrent": "{facing} is the current facing",
  "err.mpExceeded": "Move costs {spent} MP but {mode} budget is {budget}",
  "err.needsActor": "Command requires an acting unit",
  "err.unknownUnitId": "Unknown unit id: {id}",
  "err.selfTarget": "Target must belong to another team",
  "err.targetRemoved": "Target {id} is removed from play",
  "err.oneTarget":
    "A unit may only declare attacks against one target per turn (already targeting {target})",
  "err.rematchOnlyOver": "Only available when the battle is over",
  "err.seedInteger": "seed must be an integer",
  "err.phaseDriver": "phase driver failed to settle",

  // setup status
  "setup.mapLabel": "map: {name}",
  "setup.mapNone": "(none)",
  "setup.terrainCount": "terrain hexes: {n}",
  "setup.teamHeader": "team {team}:",
  "setup.unitLine": "  {id}  {model} ({name}) gunnery {gunnery} @ {pos} facing {facing}",
  "setup.noUnits": "(no units placed)",

  // movement status
  "moveStatus.noMode": "(mode not declared)",
  "moveStatus.mode": "mode: {mode}",
  "moveStatus.budget": "budget: {budget} MP",
  "moveStatus.none": "(no steps queued)",
  "moveStatus.stepTurn": "{i}. face {steps} ({from} -> {to})",
  "moveStatus.stepEnter": "{i}. enter ({col},{row})",
  "moveStatus.stepLine": "{label} +{cost} MP (total {total})",

  // attack status
  "attackStatus.none": "(no attacks queued)",
  "weapons.noActorId": "(no active unit)",

  // record sheet / info
  "info.mechListLine": "{model} {name} ({weightClass}) walk/run/jump {walk}/{run}/{jump}",
  "info.head": "{model} {name} — {weightClass} {tonnage}t ({techBase})",
  "info.movement": "movement: walk {walk} / run {run} / jump {jump}",
  "info.mapHead": "{name}: {w}x{h}",
  "info.terrainLine": "terrain: {breakdown}",
  "info.terrainNone": "none",
  "info.legend":
    "legend: w0 lightWoods  W0 heavyWoods  (blank = clear; trailing digit = elevation)",
  "sheet.head": "{model} {name} — {weightClass} {tonnage}t{gunnery}",
  "sheet.gunnerySuffix": " gunnery {gunnery}",  "sheet.at": "at {pos} facing {facing}",
  "sheet.modeSuffix": ", {mode} [mp {mp}]",
  "sheet.removedSuffix": " — REMOVED FROM PLAY",
  "sheet.armorLine": "armor: {list}",
  "sheet.weaponsHeader": "weapons ({n}):",
  "sheet.ammoFlag": "ammo {n}",
  "sheet.jammed": "[JAMMED]",
  "sheet.destroyed": "[DESTROYED]",

  // event log
  "log.turn": "-- turn {turn} --",
  "log.phase": "phase: {phase}",
  "log.initiative": "initiative: team {team} wins ({rolls})",
  "log.moveDeclared": "{id} declares {mode}",
  "log.moved": "{id} {mode} -> {pos} facing {facing} [mp {mp}]",
  "log.attacksDeclaredOne": "{id} fires at {target} ({count} weapon)",
  "log.attacksDeclaredOther": "{id} fires at {target} ({count} weapons)",
  "log.destroyed": "*** {id} DESTROYED ***",
  "log.removedEvent": "{id} removed from play",

  // attack resolution
  "res.outOfRange": "out of range",
  "res.outOfRangeLine": "{weapon} @ {distance}: out of range",
  "res.tn": "TN {total} ({parts})",
  "res.tnAuto": "auto",
  "res.line": "{weapon} @ {distance}: {gator}, roll {roll} -> {verdict}{jam}",
  "res.jamSuffix": " JAMMED",
  "res.autoHit": "auto-hit",
  "res.hit": "HIT",
  "res.miss": "MISS",
  "res.clusterRoll": "cluster roll {roll}",
  "res.hits": "hits: {groups}",
  "res.blownOff": "; {locs} blown off",
  "res.destroyedTail": "; destroyed {locs}",
} as const;

export type Catalog = Record<keyof typeof en, string>;
export type MessageKey = keyof typeof en;
