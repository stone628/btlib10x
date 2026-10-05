/**
 * Shared lookup tables for MTF parsing scripts (mtf.mjs, mtf-crit.mjs,
 * backfill-crits.mjs). Extracted here so the tables stay in sync across all
 * consumers.
 *
 * Exports:
 *   - CODE — MTF weapon codes → catalog weapon names (superset covering
 *     plain names, IS/CL compact codes, un-prefixed forms, and ammo tokens)
 *   - AMMO_TOKEN — crit-slot ammo token strings → catalog weapon names
 *   - SHOTS_PER_TON — ammo shots per ton, keyed by catalog weapon name
 *   - LOCATION — MTF body-part labels → internal location keys
 *   - LOCATIONS — canonical location key order
 *   - CRIT_SLOT_COUNTS — official per-location crit slot counts
 *   - STRUCTURE_TOKEN — crit-slot structure token → internal name
 *   - SOAK_TOKEN — crit-slot soak/armor-tech token → canonical soak name
 *   - ENGINE_CRIT_SLOTS — expected engine crit-slot counts (CT/LT/RT/total) per engine type
 *   - SOAK_CRIT_TOTALS — official soak-tech slot totals keyed by tech base
 *   - MODEL_PREFIX_NAME — MTF line-2 name → { prefix, name } for Clan
 *     model code generation
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Weapon code mapping
// ---------------------------------------------------------------------------

/**
 * MTF weapon codes → catalog weapon names. Covers plain catalog names
 * (identity), IS compact codes, Clan compact codes, un-prefixed forms (after
 * stripping "IS "/"CL "), and IS/Clan ammo tokens.
 */
export const CODE = {
  "Small Laser": "Small Laser",
  "Medium Laser": "Medium Laser",
  "Large Laser": "Large Laser",
  PPC: "PPC",
  "Snub-Nose PPC": "Snub-Nose PPC",
  Flamer: "Flamer",
  "Machine Gun": "Machine Gun",
  "Autocannon/2": "AC/2",
  "Autocannon/5": "AC/5",
  "Autocannon/10": "AC/10",
  "Autocannon/20": "AC/20",
  "Ultra AC/5": "Ultra AC/5",
  "Large Pulse Laser": "Large Pulse Laser",
  "Small Pulse Laser": "Small Pulse Laser",
  "LRM 5": "LRM 5",
  "LRM 10": "LRM 10",
  "LRM 15": "LRM 15",
  "LRM 20": "LRM 20",
  "SRM 2": "SRM 2",
  "SRM 4": "SRM 4",
  "SRM 6": "SRM 6",
  // IS compact codes.
  ISMediumLaser: "Medium Laser",
  ISLargeLaser: "Large Laser",
  ISSmallLaser: "Small Laser",
  ISPPC: "PPC",
  ISSNPPC: "Snub-Nose PPC",
  ISFlamer: "Flamer",
  ISMachineGun: "Machine Gun",
  ISAC2: "AC/2",
  ISAC5: "AC/5",
  ISAC10: "AC/10",
  ISAC20: "AC/20",
  ISUltraAC5: "Ultra AC/5",
  ISLargePulseLaser: "Large Pulse Laser",
  ISSmallPulseLaser: "Small Pulse Laser",
  ISLRM5: "LRM 5",
  ISLRM10: "LRM 10",
  ISLRM15: "LRM 15",
  ISLRM20: "LRM 20",
  ISSRM2: "SRM 2",
  ISSRM4: "SRM 4",
  ISSRM6: "SRM 6",
  ISGaussRifle: "Gauss Rifle",
  ISLBXAC10: "LB 10-X AC",
  ISMediumPulseLaser: "Medium Pulse Laser",
  // Clan compact codes.
  CLERMediumLaser: "CL ER Medium Laser",
  CLERLargeLaser: "CL ER Large Laser",
  CLERPPC: "CL ER PPC",
  CLMediumPulseLaser: "CL Medium Pulse Laser",
  CLStreakSRM2: "CL Streak SRM 2",
  CLStreakSRM4: "CL Streak SRM 4",
  CLStreakSRM6: "CL Streak SRM 6",
  CLMG: "CL Machine Gun",
  CLLRM10: "CL LRM 10",
  CLLRM20: "CL LRM 20",
  CLLBXAC10: "CL LB 10-X AC",
  CLLBXAC20: "CL LB 20-X AC",
  // Un-prefixed forms (after stripping "IS "/"CL ").
  LBXAC10: "CL LB 10-X AC",
  LBXAC20: "CL LB 20-X AC",
  // Physical-weapon equipment (Hatchet, TW p.146): modeled as a weapon mount
  // with `physicalWeapon: true` in the catalog, linked from crit slots like
  // any other weapon (precedent: HCT-5S ships a Hatchet mount + slots).
  Hatchet: "Hatchet",
  // Un-prefixed "Gauss" crit-slot tokens ("CLGauss Ammo", "GaussRifle") are
  // Clan by convention; the IS Gauss Rifle is reached through the explicit
  // spaced "Gauss Rifle" form used in weapons blocks (see below).
  GaussRifle: "Gauss Rifle",
  Gauss: "Gauss Rifle",
  CLGauss: "CL Gauss Rifle",
  CLGaussRifle: "CL Gauss Rifle",
  // Spaced "Gauss Rifle" form used in the weapons block of IS 'Mechs (e.g.
  // Hollander BZK-F3). Maps to the Inner Sphere catalog entry.
  "Gauss Rifle": "Gauss Rifle",
  // Plain "ER Large Laser" maps to the Clan Extended-Range Large Laser,
  // matching the prefixed "ERLargeLaser" entry above.
  "ER Large Laser": "ER Large Laser",
  StreakSRM2: "Streak SRM 2",
  StreakSRM4: "Streak SRM 4",
  StreakSRM6: "Streak SRM 6",
  ERMediumLaser: "ER Medium Laser",
  ERLargeLaser: "ER Large Laser",
  ERPPC: "ER PPC",
  MediumPulseLaser: "Medium Pulse Laser",
  LRM20: "LRM 20",
  // IS ammo tokens ("IS Ammo AC/20" etc).
  "AC/2": "AC/2",
  "AC/5": "AC/5",
  "AC/10": "AC/10",
  "AC/20": "AC/20",
  "LRM-5": "LRM 5",
  "LRM-10": "LRM 10",
  "LRM-15": "LRM 15",
  "LRM-20": "LRM 20",
  "SRM-2": "SRM 2",
  "SRM-4": "SRM 4",
  "SRM-6": "SRM 6",
  // Crit-slot ammo stems ("<stem> Ammo", including the trailing " CL" and
  // "- Half" variants seen in the wild). Direct entries so the tech base
  // resolves before the normalized fallback strips prefixes.
  "ISLBXAC10 CL": "LB 10-X AC",
  "CLLBXAC20 CL": "CL LB 20-X AC",
  "IS Gauss": "Gauss Rifle",
  "IS Machine Gun": "Machine Gun",
  // Clan ammo tokens.
  "CLLB-20 AC": "CL LB 20-X AC",
  "CLLB-10 AC": "CL LB 10-X AC",
  "LB-20 AC": "LB 20-X AC",
  "LB-10 AC": "LB 10-X AC",
  // Plain catalog names that sheets emit un-prefixed (Inner Sphere unless the
  // catalog name itself carries "CL ").
  "Medium Pulse Laser": "Medium Pulse Laser",
  "ER PPC": "ER PPC",
  "ER Medium Laser": "ER Medium Laser",
  "ER Small Laser": "ER Small Laser",
  "Streak SRM 2": "Streak SRM 2",
  "Streak SRM 4": "Streak SRM 4",
  "Streak SRM 6": "Streak SRM 6",
  "LB 10-X AC": "LB 10-X AC",
  "LB 20-X AC": "LB 20-X AC",
  "Anti-Missile System": "Anti-Missile System",
  AMS: "Anti-Missile System",
  ISAMS: "Anti-Missile System",
  ISMG: "Machine Gun",
  TAG: "TAG",
  // Additional IS compact codes.
  ISERPPC: "ER PPC",
  ISERLargeLaser: "ER Large Laser",
  ISERMediumLaser: "ER Medium Laser",
  ISERSmallLaser: "ER Small Laser",
  ISStreakSRM2: "Streak SRM 2",
  ISStreakSRM4: "Streak SRM 4",
  ISStreakSRM6: "Streak SRM 6",
  "ISMachine Gun": "Machine Gun",
  ISAntiMissileSystem: "Anti-Missile System",
  ISTAG: "TAG",
  // MegaMek's alias for the PPC.
  "Particle Cannon": "PPC",
};

/**
 * Equipment with no engine representation (no catalog entry, no rules
 * effect). Weapons-block lines naming these are dropped; crit slots naming
 * them become inert `soak` slots (`equipment`) that occupy space but re-roll
 * on a critical hit. Keys are crit/weapon tokens, matched after stripping
 * facing/parenthetical suffixes.
 */
export const INERT_EQUIPMENT = new Set([
  "ISGuardianECM",
  "ISGuardianECMSuite",
  "ISBeagleActiveProbe",
  "BeagleActiveProbe",
  "ISArtemisIV",
  "ISMASC",
  "Supercharger",
  "Mek Null Signature System",
  "Chameleon Light Polarization Shield",
  "Chameleon Light Polarization Field",
  "ISCollapsibleCommandModule",
  "CLMASC",
  "CLArtemisIV",
  "ISC3SlaveUnit",
  "ISC3MasterUnit",
  "ISC3MasterComputer",
  "C3 Master with TAG",
  "ISElectronicWarfareEquipment",
  "ISLaserInsulator",
  "RemoteSensorDispenser",
]);

/**
 * Crit-slot ammo token strings → catalog weapon names. Subset of CODE
 * covering the "IS Ammo <token>" format in crit-slot sections.
 */
export const AMMO_TOKEN = {
  "AC/2": "AC/2",
  "AC/5": "AC/5",
  "AC/10": "AC/10",
  "AC/20": "AC/20",
  "LRM-5": "LRM 5",
  "LRM-10": "LRM 10",
  "LRM-15": "LRM 15",
  "LRM-20": "LRM 20",
  "SRM-2": "SRM 2",
  "SRM-4": "SRM 4",
  "SRM-6": "SRM 6",
  "Machine Gun": "Machine Gun",
  MG: "Machine Gun",
  AMS: "Anti-Missile System",
  "Streak SRM 2": "Streak SRM 2",
  "Streak SRM 4": "Streak SRM 4",
  "Streak SRM 6": "Streak SRM 6",
  "LB 10-X AC": "LB 10-X AC",
  "LB 10-X Cluster": "LB 10-X AC",
  "LB 20-X AC": "LB 20-X AC",
  "LB 20-X Cluster": "LB 20-X AC",
  Gauss: "Gauss Rifle",
  "Gauss Rifle": "Gauss Rifle",
  CLGauss: "CL Gauss Rifle",
  CLGaussRifle: "CL Gauss Rifle",
};

// ---------------------------------------------------------------------------
// Ammo
// ---------------------------------------------------------------------------

/** Shots per ton of ammunition, keyed by catalog weapon name. */
export const SHOTS_PER_TON = {
  "AC/2": 45,
  "AC/5": 20,
  "AC/10": 10,
  "AC/20": 5,
  "Machine Gun": 200,
  "Ultra AC/5": 20,
  "LRM 5": 24,
  "LRM 10": 12,
  "LRM 15": 8,
  "LRM 20": 6,
  "SRM 2": 50,
  "SRM 4": 25,
  "SRM 6": 15,
  "CL Streak SRM 2": 50,
  "CL Streak SRM 4": 25,
  "CL Streak SRM 6": 15,
  "CL LRM 20": 12,
  "CL Machine Gun": 200,
  "Gauss Rifle": 8,
  "CL Gauss Rifle": 16,
  "LB 10-X AC": 10,
  "LB 20-X AC": 5,
  "Anti-Missile System": 12,
  "Streak SRM 2": 50,
  "Streak SRM 4": 25,
  "Streak SRM 6": 15,
  "CL LB 10-X AC": 10,
  "CL LB 20-X AC": 5,
};

// ---------------------------------------------------------------------------
// Body locations
// ---------------------------------------------------------------------------

/** MTF body-part labels → internal location keys. */
export const LOCATION = {
  Head: "head",
  "Center Torso": "centerTorso",
  "Right Torso": "rightTorso",
  "Left Torso": "leftTorso",
  "Right Arm": "rightArm",
  "Left Arm": "leftArm",
  "Right Leg": "rightLeg",
  "Left Leg": "leftLeg",
  CT: "centerTorso",
  RT: "rightTorso",
  LT: "leftTorso",
  RA: "rightArm",
  LA: "leftArm",
  HD: "head",
  LL: "rightLeg",
  RL: "leftLeg",
};

/** Canonical location key order. */
export const LOCATIONS = [
  "head",
  "centerTorso",
  "rightTorso",
  "leftTorso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
];

/** Official crit slot counts per location (head/legs = 6, torso/arms = 12). */
export const CRIT_SLOT_COUNTS = {
  head: 6,
  centerTorso: 12,
  rightTorso: 12,
  leftTorso: 12,
  rightArm: 12,
  leftArm: 12,
  rightLeg: 6,
  leftLeg: 6,
};

// ---------------------------------------------------------------------------
// Crit-slot structure / soak tokens
// ---------------------------------------------------------------------------

export const STRUCTURE_TOKEN = {
  Cockpit: "cockpit",
  Sensors: "sensors",
  "Life Support": "lifeSupport",
  "Fusion Engine": "engine",
  Engine: "engine",
  Gyro: "gyro",
  "Heat Sink": "heatSink",
  "ISDouble Heat Sink": "doubleHeatSink",
  ISDoubleHeatSink: "doubleHeatSink",
  ISDoubleHeatSinkPrototype: "doubleHeatSink",
  CLDoubleHeatSink: "doubleHeatSink",
  ISPrototypeJumpJet: "jumpJet",
  ISPrototypeImprovedJumpJet: "jumpJet",
  ISImprovedJumpJet: "jumpJet",
  ISJumpJet: "jumpJet",
  "CLDouble Heat Sink": "doubleHeatSink",
  "Double Heat Sink": "doubleHeatSink",
  "Jump Jet": "jumpJet",
  Shoulder: "shoulder",
  "Upper Arm Actuator": "upperArmActuator",
  "Lower Arm Actuator": "lowerArmActuator",
  "Hand Actuator": "handActuator",
  Hip: "hip",
  "Upper Leg Actuator": "upperLegActuator",
  "Lower Leg Actuator": "lowerLegActuator",
  "Foot Actuator": "footActuator",
  "CLTargeting Computer": "targetingComputer",
  "ISTargeting Computer": "targetingComputer",
};

export const SOAK_TOKEN = {
  "Endo Steel": "endoSteel",
  "IS Endo Steel": "endoSteel",
  "CL Endo Steel": "endoSteel",
  "Clan Endo Steel": "endoSteel",
  "Clan Endo-Steel": "endoSteel",
  "CL Endo Steel (IS)": "endoSteel",
  "IS Endo-Steel": "endoSteel",
  "Endo-Steel": "endoSteel",
  // Triple-Strength Myomer (TW p.143): occupies 6 crit slots; critical hits
  // on TSM slots have no effect (re-roll), so it soaks like armor tech.
  "Triple Strength Myomer": "tsm",
  TSM: "tsm",
  CASE: "case",
  ISCASE: "case",
  "IS CASE": "case",
  "CL CASE": "case",
  "Ferro-Fibrous": "ferroFibrous",
  "IS Ferro-Fibrous": "ferroFibrous",
  "CL Ferro-Fibrous": "ferroFibrous",
  "Clan Ferro-Fibrous": "ferroFibrous",
  "Ferro-Fibrous (CL)": "ferroFibrous",
};

// ---------------------------------------------------------------------------
// Construction validation constraints
// ---------------------------------------------------------------------------

/**
 * Expected critical-slot counts per engine type (TechManual "Mech Engine
 * Critical Space Table"). Counts per location plus the total. Compact and XXL
 * engines are intentionally omitted for now (deferred).
 */
export const ENGINE_CRIT_SLOTS = {
  standard: { ct: 6, lt: 0, rt: 0, total: 6 },
  isLight: { ct: 6, lt: 1, rt: 1, total: 8 },
  clanXL: { ct: 6, lt: 2, rt: 2, total: 10 },
  isXL: { ct: 6, lt: 3, rt: 3, total: 12 },
};

/**
 * Official soak-tech critical-slot totals keyed by Internal Structure / armor
 * tech, then by tech base. Inner Sphere tech occupies 14 slots, Clan 7.
 */
export const SOAK_CRIT_TOTALS = {
  endoSteel: { "Inner Sphere": 14, Clan: 7 },
  ferroFibrous: { "Inner Sphere": 14, Clan: 7 },
};

/**
 * Crit slots occupied by one double heat sink device, by tech base
 * (TechManual "Additional Heat Sinks").
 */
export const DHS_CRIT_SLOTS = {
  "Inner Sphere": 3,
  Clan: 2,
};

// ---------------------------------------------------------------------------
// Model code generation
// ---------------------------------------------------------------------------

/**
 * Mech name → model code prefix and canonical display name.
 *
 * Clan MTF sheets do not carry a usable model code on line 3 (e.g. "Prime"
 * or "2"), so the importer synthesises the catalog key as
 * `<prefix>-<variant>` ("TBR-Prime", "MC-MKII-2"). Keys are the full MTF
 * line-2 strings; `name` is the canonical outer (Inner Sphere reporting)
 * name stored in `MechDef.name` — the parenthesised Clan name goes to
 * `MechDef.clanName` instead.
 *
 * Example: "Mad Cat Mk II" + variant "2" → "MC-MKII-2"
 *
 * No canonical prefixes exist (lore names Clan configurations only by
 * "Prime" / letter / number); codes follow MechWarrior Online conventions.
 */
export const MODEL_PREFIX_NAME = {
  "Mad Cat Mk II": { prefix: "MC-MKII", name: "Mad Cat Mk II" },
  "Mad Cat (Timber Wolf)": { prefix: "TBR", name: "Mad Cat" },
  "Masakari (Warhawk)": { prefix: "WHK", name: "Masakari" },
  Archer: { prefix: "ARC", name: "Archer" },
  Locust: { prefix: "LCT", name: "Locust" },
  Rifleman: { prefix: "RFL", name: "Rifleman" },
  Victor: { prefix: "VTR", name: "Victor" },
  Marauder: { prefix: "MAD", name: "Marauder" },
  Annihilator: { prefix: "ANH", name: "Annihilator" },
  Atlas: { prefix: "AS7", name: "Atlas" },
  "Baboon (Howler)": { prefix: "HWL", name: "Baboon" },
  "Battle Cobra": { prefix: "BCB", name: "Battle Cobra" },
  "Behemoth (Stone Rhino)": { prefix: "SRH", name: "Behemoth" },
  "Black Hawk (Nova)": { prefix: "NOV", name: "Black Hawk" },
  "Black Lanner": { prefix: "BLN", name: "Black Lanner" },
  "Blood Kite": { prefix: "BKT", name: "Blood Kite" },
  Bowman: { prefix: "BWM", name: "Bowman" },
  "Cauldron-Born (Ebon Jaguar)": { prefix: "EBJ", name: "Cauldron-Born" },
  Champion: { prefix: "CHP", name: "Champion" },
  "Clint IIC": { prefix: "CLNT-IIC", name: "Clint IIC" },
  "Commando IIC": { prefix: "COM-IIC", name: "Commando IIC" },
  Corvis: { prefix: "CRV", name: "Corvis" },
  Coyotl: { prefix: "COY", name: "Coyotl" },
  Crossbow: { prefix: "XBW", name: "Crossbow" },
  "Daishi (Dire Wolf)": { prefix: "DWF", name: "Daishi" },
  "Dasher (Fire Moth)": { prefix: "FMT", name: "Dasher" },
  Devil: { prefix: "DVL", name: "Devil" },
  "Dragonfly (Viper)": { prefix: "VPR", name: "Dragonfly" },
  "Drift Shag": { prefix: "DSG", name: "Drift Shag" },
  "Fenris (Ice Ferret)": { prefix: "IFR", name: "Fenris" },
  "Fire Falcon": { prefix: "FFC", name: "Fire Falcon" },
  Firefly: { prefix: "FFL", name: "Firefly" },
  Fox: { prefix: "FOX", name: "Fox" },
  "Galahad (Glass Spider)": { prefix: "GSP", name: "Galahad" },
  Gallowglas: { prefix: "GLG", name: "Gallowglas" },
  "Gladiator (Executioner)": { prefix: "EXE", name: "Gladiator" },
  "Gladiator-B (Executioner-B)": { prefix: "EXB", name: "Gladiator-B" },
  "Goshawk (Vapor Eagle)": { prefix: "VEG", name: "Goshawk" },
  "Great Wyrm": { prefix: "GWY", name: "Great Wyrm" },
  "Grendel (Mongrel)": { prefix: "MGL", name: "Grendel" },
  "Griffin IIC": { prefix: "GRF-IIC", name: "Griffin IIC" },
  Grizzly: { prefix: "GZL", name: "Grizzly" },
  "Guillotine IIC": { prefix: "GLT-IIC", name: "Guillotine IIC" },
  "Hankyu (Arctic Cheetah)": { prefix: "ACH", name: "Hankyu" },
  "Hellhound (Conjurer)": { prefix: "CNJ", name: "Hellhound" },
  "Highlander IIC": { prefix: "HGN-IIC", name: "Highlander IIC" },
  Hoplite: { prefix: "HOP", name: "Hoplite" },
  "Hunchback IIC": { prefix: "HBK-IIC", name: "Hunchback IIC" },
  Icestorm: { prefix: "ICS", name: "Icestorm" },
  Imp: { prefix: "IMP", name: "Imp" },
  "Iron Cheetah": { prefix: "ICH", name: "Iron Cheetah" },
  "Jenner IIC": { prefix: "JR7-IIC", name: "Jenner IIC" },
  Kingfisher: { prefix: "KGF", name: "Kingfisher" },
  Kodiak: { prefix: "KDK", name: "Kodiak" },
  "Koshi (Mist Lynx)": { prefix: "MLX", name: "Koshi" },
  "Kraken (Bane)": { prefix: "BNE", name: "Kraken" },
  Lancelot: { prefix: "LNC", name: "Lancelot" },
  Linebacker: { prefix: "LBK", name: "Linebacker" },
  "Locust IIC": { prefix: "LCT-IIC", name: "Locust IIC" },
  "Loki (Hellbringer)": { prefix: "HBR", name: "Loki" },
  Lupus: { prefix: "LPS", name: "Lupus" },
  Lynx: { prefix: "LNX", name: "Lynx" },
  "Man O' War (Gargoyle)": { prefix: "GAR", name: "Man O' War" },
  Mandrill: { prefix: "MDR", name: "Mandrill" },
  "Marauder IIC": { prefix: "MAD-IIC", name: "Marauder IIC" },
  Masauwu: { prefix: "MSW", name: "Masauwu" },
  Matador: { prefix: "MTD", name: "Matador" },
  Minsk: { prefix: "MNK", name: "Minsk" },
  Mongoose: { prefix: "MON", name: "Mongoose" },
  "Naga II": { prefix: "NGA-II", name: "Naga II" },
  Naga: { prefix: "NGA", name: "Naga" },
  Naja: { prefix: "NJA", name: "Naja" },
  "Night Chanter": { prefix: "NCH", name: "Night Chanter" },
  "Night Gyr": { prefix: "NGR", name: "Night Gyr" },
  "Nobori-nin (Huntsman)": { prefix: "HNT", name: "Nobori-nin" },
  "Omni-Corvis": { prefix: "OCR", name: "Omni-Corvis" },
  "Orion IIC": { prefix: "ON1-IIC", name: "Orion IIC" },
  "Peregrine (Horned Owl)": { prefix: "HOW", name: "Peregrine" },
  Phantom: { prefix: "PNT", name: "Phantom" },
  "Phoenix Hawk IIC": { prefix: "PXH-IIC", name: "Phoenix Hawk IIC" },
  "Phoenix Hawk": { prefix: "PXH", name: "Phoenix Hawk" },
  Piranha: { prefix: "PRH", name: "Piranha" },
  Pouncer: { prefix: "PNC", name: "Pouncer" },
  Pulverizer: { prefix: "PLV", name: "Pulverizer" },
  "Puma (Adder)": { prefix: "ADR", name: "Puma" },
  "Rifleman IIC": { prefix: "RFL-IIC", name: "Rifleman IIC" },
  "Roadrunner (Emerald Harrier)": { prefix: "EHR", name: "Roadrunner" },
  "Ryoken (Stormcrow)": { prefix: "SCR", name: "Ryoken" },
  "Shadow Cat": { prefix: "SHC", name: "Shadow Cat" },
  "Shadow Hawk IIC": { prefix: "SHD-IIC", name: "Shadow Hawk IIC" },
  Shogun: { prefix: "SHG", name: "Shogun" },
  Spartan: { prefix: "SPT", name: "Spartan" },
  "Spirit Walker": { prefix: "SPW", name: "Spirit Walker" },
  Stinger: { prefix: "STG", name: "Stinger" },
  "Stooping Hawk": { prefix: "STH", name: "Stooping Hawk" },
  "Storm Giant": { prefix: "SGT", name: "Storm Giant" },
  "Sun Bear": { prefix: "SNB", name: "Sun Bear" },
  Supernova: { prefix: "SNV", name: "Supernova" },
  "Thor (Summoner)": { prefix: "SMN", name: "Thor" },
  Thresher: { prefix: "THR", name: "Thresher" },
  Thunderbolt: { prefix: "TDR", name: "Thunderbolt" },
  Turkina: { prefix: "TKN", name: "Turkina" },
  "Uller (Kit Fox)": { prefix: "KFX", name: "Uller" },
  "UrbanMech IIC": { prefix: "UM-IIC", name: "UrbanMech IIC" },
  "Viper (Black Python)": { prefix: "BPY", name: "Viper" },
  Viper: { prefix: "VIP", name: "Viper" },
  "Vision Quest": { prefix: "VQS", name: "Vision Quest" },
  "Vixen (Incubus)": { prefix: "INC", name: "Vixen" },
  "Vulture (Mad Dog)": { prefix: "MDD", name: "Vulture" },
  Wakazashi: { prefix: "WKZ", name: "Wakazashi" },
  "Warhammer IIC": { prefix: "WHM-IIC", name: "Warhammer IIC" },
  Warhammer: { prefix: "WHM", name: "Warhammer" },
  Arcas: { prefix: "ARS", name: "Arcas" },
  "Arctic Wolf": { prefix: "AWF", name: "Arctic Wolf" },
  Canis: { prefix: "CNS", name: "Canis" },
  Cougar: { prefix: "CGR", name: "Cougar" },
  "Ha Otoko": { prefix: "HOT", name: "Ha Otoko" },
  Hellfire: { prefix: "HLF", name: "Hellfire" },
  Hellion: { prefix: "HLN", name: "Hellion" },
  Lobo: { prefix: "LBO", name: "Lobo" },
  "Nova Cat": { prefix: "NVC", name: "Nova Cat" },
  "Pack Hunter": { prefix: "PKH", name: "Pack Hunter" },
  Predator: { prefix: "PRD", name: "Predator" },
  "Savage Coyote": { prefix: "SVC", name: "Savage Coyote" },
  Scylla: { prefix: "SCY", name: "Scylla" },
  Spirit: { prefix: "SPR", name: "Spirit" },
  "Star Adder (Blood Asp)": { prefix: "BSP", name: "Star Adder" },
  Tomahawk: { prefix: "TMH", name: "Tomahawk" },
  Uller: { prefix: "KFX", name: "Uller" },
  Ursus: { prefix: "URS", name: "Ursus" },
  BattleMaster: { prefix: "BLR", name: "BattleMaster" },
  "Bear Cub": { prefix: "BCU", name: "Bear Cub" },
  Burrock: { prefix: "BRK", name: "Burrock" },
  "Crimson Hawk": { prefix: "CHK", name: "Crimson Hawk" },
  "Crimson Langur": { prefix: "CLG", name: "Crimson Langur" },
  Falcon: { prefix: "FLC", name: "Falcon" },
  Hunchback: { prefix: "HBK", name: "Hunchback" },
  Jupiter: { prefix: "JPT", name: "Jupiter" },
  "Marauder II": { prefix: "MAD-II", name: "Marauder II" },
  Ocelot: { prefix: "OCL", name: "Ocelot" },
  Pinion: { prefix: "PNN", name: "Pinion" },
  "Rabid Coyote": { prefix: "RCY", name: "Rabid Coyote" },
  Solitaire: { prefix: "SLT", name: "Solitaire" },
  Thor: { prefix: "SMN", name: "Thor" },
  Woodsman: { prefix: "WDS", name: "Woodsman" },
  "Wyvern IIC": { prefix: "WVE-IIC", name: "Wyvern IIC" },
};

// ---------------------------------------------------------------------------
// Catalog-aware weapon resolution
// ---------------------------------------------------------------------------

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
const catalogNames = [
  ...readFileSync(join(dataDir, "weapons.data.ts"), "utf8").matchAll(/^\s+name: "([^"]+)",/gm),
].map((m) => m[1]);

function squash(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Catalog weapon names keyed by their squashed form ("CL ER PPC" -> "clerppc"). */
const CATALOG_INDEX = new Map(catalogNames.map((n) => [squash(n), n]));

/** MTF spellings that squash differently from the catalog name. */
const STEM_ALIAS = {
  gauss: "gaussrifle",
  mg: "machinegun",
  antipersonnelpod: "apod",
  narcbeacon: "narcmissilebeacon",
  narcpods: "narcmissilebeacon",
};

/** Equipment whose Clan and IS versions are the same catalog entry. */
const TECH_AGNOSTIC = new Set(["antimissilesystem", "apod"]);

/**
 * Resolve an MTF weapon / ammo token to a catalog weapon name by squashing it
 * (case, spacing, punctuation, "IS"/"CL"/"Clan" prefix, trailing
 * "(omnipod)"/"(R)"-style parentheticals and "Cluster" LB-X ammo) and looking
 * the stem up in the catalog. An explicit prefix selects the tech base; an
 * unprefixed token follows `clan` (the sheet's tech base). The Clan and IS
 * entries are never substituted for one another except for the tech-agnostic
 * equipment above. Returns null when the catalog has no such weapon.
 */
export function catalogWeapon(token, clan = false) {
  let t = token.trim();
  for (;;) {
    const next = t.replace(/\s*\([^()]*\)\s*$/, "");
    if (next === t) break;
    t = next;
  }
  let x = squash(t.replace(/\s+CL$/, "").replace(/^Clan\s+/i, "CL"));
  let tech = clan ? "cl" : "is";
  const prefix = /^(cl|is)(?=[a-z0-9])/.exec(x);
  if (prefix) {
    tech = prefix[1];
    x = x.slice(2);
  }
  x = x
    .replace(/^lbxac(\d+)$/, "lb$1xac")
    .replace(/^lb(\d+)xcluster$/, "lb$1xac")
    .replace(/^lb(\d+)xac$/, "lb$1xac");
  x = STEM_ALIAS[x] ?? x;
  if (tech === "cl") {
    const hit = CATALOG_INDEX.get(`cl${x}`);
    if (hit) return hit;
    return TECH_AGNOSTIC.has(x) || /^atm\d+$/.test(x) ? (CATALOG_INDEX.get(x) ?? null) : null;
  }
  return CATALOG_INDEX.get(x) ?? null;
}

/**
 * Catalog weapons in the EQUIPMENT category (probes, ECM, AMS, TAG, pods).
 * Sheets often list these only in the crit slots, not in the weapons block.
 */
export const EQUIPMENT_WEAPONS = new Set(
  [
    ...readFileSync(join(dataDir, "weapons.data.ts"), "utf8").matchAll(
      /name: "([^"]+)"[^}]*?category: "EQUIPMENT"/g,
    ),
  ].map((m) => m[1]),
);
