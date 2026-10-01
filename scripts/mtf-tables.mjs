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
 *   - MODEL_CODE — mech name → model code prefix for non-trivial name generation
 */

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
};

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
};

export const SOAK_TOKEN = {
  "Endo Steel": "endoSteel",
  "IS Endo Steel": "endoSteel",
  "CL Endo Steel": "endoSteel",
  "CL Endo Steel (IS)": "endoSteel",
  "IS Endo-Steel": "endoSteel",
  "Endo-Steel": "endoSteel",
  CASE: "case",
  ISCASE: "case",
  "IS CASE": "case",
  "CL CASE": "case",
  "Ferro-Fibrous": "ferroFibrous",
  "IS Ferro-Fibrous": "ferroFibrous",
  "CL Ferro-Fibrous": "ferroFibrous",
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
 * Mech name → model code prefix for non-trivial name generation.
 *
 * When an MTF model line is a bare variant number (e.g. "2" for Mad Cat Mk
 * II), the importer needs to synthesise a full model code. This table maps
 * the `name` field to a prefix; the variant suffix from the MTF is appended
 * with a dash separator.
 *
 * Entries are only required for names whose abbreviation is ambiguous or
 * non-obvious. Trivial cases (e.g. "Wolverine" → "WVR") can be derived
 * from the existing model code in the MTF and don't need entries here.
 *
 * Example: "Mad Cat Mk II" + variant "2" → "MC-MKII-2"
 */
export const MODEL_CODE = {
  "Mad Cat Mk II": "MC-MKII",
  "Mad Cat (Timber Wolf)": "TW",
  "Masakari (Warhawk)": "WHK",
};
