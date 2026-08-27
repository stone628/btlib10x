// src/core/dice.ts
function rollD6(rng) {
  return rng.d6();
}
function roll2D6(rng) {
  return rng.d6() + rng.d6();
}

// src/core/types.ts
var FACINGS = ["n", "ne", "se", "s", "sw", "nw"];
function isFacing(value) {
  return typeof value === "string" && FACINGS.includes(value);
}
function rotateFacing(facing, steps) {
  const n = FACINGS.length;
  const idx = ((FACINGS.indexOf(facing) + steps) % n + n) % n;
  return FACINGS[idx];
}
function oppositeFacing(facing) {
  return rotateFacing(facing, 3);
}
var TERRAIN_TYPES = ["clear", "lightWoods", "heavyWoods"];
function isTerrainType(value) {
  return typeof value === "string" && TERRAIN_TYPES.includes(value);
}
var LOCATIONS = [
  "head",
  "centerTorso",
  "rightTorso",
  "leftTorso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg"
];
function isLocation(value) {
  return LOCATIONS.includes(value);
}

// src/core/hex.ts
var EVEN_COL_DELTAS = {
  n: [0, -1],
  s: [0, 1],
  ne: [1, 0],
  se: [1, 1],
  nw: [-1, 0],
  sw: [-1, 1]
};
var ODD_COL_DELTAS = {
  n: [0, -1],
  s: [0, 1],
  ne: [1, -1],
  se: [1, 0],
  nw: [-1, -1],
  sw: [-1, 0]
};
function neighbor(hex, facing) {
  const deltas = hex.col % 2 === 0 ? EVEN_COL_DELTAS : ODD_COL_DELTAS;
  const pair = deltas[facing];
  return { col: hex.col + pair[0], row: hex.row + pair[1] };
}
function neighbors(hex) {
  return FACINGS.map((facing) => neighbor(hex, facing));
}
function offsetToCube(hex) {
  const x = hex.col;
  const z = hex.row - (hex.col + (hex.col & 1)) / 2;
  const y = -x - z;
  return { x, y, z };
}
function cubeToOffset(x, _y, z) {
  const col = x;
  const row = z + (col + (col & 1)) / 2;
  return { col, row };
}
function hexDistance(a, b) {
  const ca = offsetToCube(a);
  const cb = offsetToCube(b);
  return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y), Math.abs(ca.z - cb.z));
}
function sameHex(a, b) {
  return a.col === b.col && a.row === b.row;
}
function lineHexes(from, to) {
  if (sameHex(from, to)) return [];
  const a = offsetToCube(from);
  const b = offsetToCube(to);
  const n = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  const result = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const pz = a.z + (b.z - a.z) * t;
    result.push(cubeRound(px, py, pz));
  }
  return result;
}
function cubeRound(px, py, pz) {
  let rx = Math.round(px);
  let ry = Math.round(py);
  let rz = Math.round(pz);
  const dx = Math.abs(rx - px);
  const dy = Math.abs(ry - py);
  const dz = Math.abs(rz - pz);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return cubeToOffset(rx, ry, rz);
}
function bearing(from, to) {
  if (sameHex(from, to)) return null;
  for (const f of FACINGS) {
    if (sameHex(neighbor(from, f), to)) return f;
  }
  const a = offsetToCube(from);
  const b = offsetToCube(to);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const compassDeg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  const sector = Math.floor((compassDeg + 30) % 360 / 60);
  return FACINGS[sector];
}

// src/core/terrain.ts
var MP_TO_ENTER_HEX = 1;
function terrainMoveCost(terrain) {
  switch (terrain) {
    case "clear":
      return 0;
    case "lightWoods":
      return 1;
    case "heavyWoods":
      return 2;
  }
}
function costToEnter(terrain) {
  return MP_TO_ENTER_HEX + terrainMoveCost(terrain);
}
var MP_PER_FACING_CHANGE = 1;
function woodsPoints(terrain) {
  switch (terrain) {
    case "clear":
      return 0;
    case "lightWoods":
      return 1;
    case "heavyWoods":
      return 2;
  }
}

// src/data/maps/beginner.json
var beginner_default = {
  width: 15,
  height: 16,
  terrain: [
    {
      col: 2,
      row: 5,
      type: "heavyWoods"
    },
    {
      col: 3,
      row: 6,
      type: "heavyWoods"
    },
    {
      col: 11,
      row: 3,
      type: "heavyWoods"
    },
    {
      col: 13,
      row: 2,
      type: "heavyWoods"
    },
    {
      col: 13,
      row: 9,
      type: "heavyWoods"
    },
    {
      col: 14,
      row: 10,
      type: "heavyWoods"
    },
    {
      col: 6,
      row: 13,
      type: "heavyWoods"
    },
    {
      col: 4,
      row: 5,
      type: "lightWoods"
    },
    {
      col: 4,
      row: 6,
      type: "lightWoods"
    },
    {
      col: 10,
      row: 4,
      type: "lightWoods"
    },
    {
      col: 11,
      row: 4,
      type: "lightWoods"
    },
    {
      col: 11,
      row: 5,
      type: "lightWoods"
    },
    {
      col: 12,
      row: 2,
      type: "lightWoods"
    },
    {
      col: 12,
      row: 3,
      type: "lightWoods"
    },
    {
      col: 12,
      row: 11,
      type: "lightWoods"
    },
    {
      col: 13,
      row: 10,
      type: "lightWoods"
    },
    {
      col: 13,
      row: 11,
      type: "lightWoods"
    },
    {
      col: 5,
      row: 14,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 14,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 15,
      type: "lightWoods"
    }
  ]
};

// src/data/maps/quickstart.json
var quickstart_default = {
  width: 15,
  height: 16,
  terrain: [
    {
      col: 4,
      row: 3,
      type: "heavyWoods"
    },
    {
      col: 12,
      row: 8,
      type: "heavyWoods"
    },
    {
      col: 14,
      row: 8,
      type: "heavyWoods"
    },
    {
      col: 4,
      row: 11,
      type: "heavyWoods"
    },
    {
      col: 5,
      row: 12,
      type: "heavyWoods"
    },
    {
      col: 5,
      row: 13,
      type: "heavyWoods"
    },
    {
      col: 7,
      row: 14,
      type: "heavyWoods"
    },
    {
      col: 8,
      row: 14,
      type: "heavyWoods"
    },
    {
      col: 5,
      row: 3,
      type: "lightWoods"
    },
    {
      col: 5,
      row: 4,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 4,
      type: "lightWoods"
    },
    {
      col: 15,
      row: 7,
      type: "lightWoods"
    },
    {
      col: 15,
      row: 8,
      type: "lightWoods"
    },
    {
      col: 11,
      row: 8,
      type: "lightWoods"
    },
    {
      col: 12,
      row: 9,
      type: "lightWoods"
    },
    {
      col: 13,
      row: 8,
      type: "lightWoods"
    },
    {
      col: 13,
      row: 9,
      type: "lightWoods"
    },
    {
      col: 14,
      row: 9,
      type: "lightWoods"
    },
    {
      col: 2,
      row: 11,
      type: "lightWoods"
    },
    {
      col: 2,
      row: 12,
      type: "lightWoods"
    },
    {
      col: 3,
      row: 12,
      type: "lightWoods"
    },
    {
      col: 4,
      row: 12,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 11,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 12,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 13,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 14,
      type: "lightWoods"
    },
    {
      col: 7,
      row: 15,
      type: "lightWoods"
    },
    {
      col: 8,
      row: 13,
      type: "lightWoods"
    },
    {
      col: 9,
      row: 14,
      type: "lightWoods"
    },
    {
      col: 9,
      row: 15,
      type: "lightWoods"
    },
    {
      col: 10,
      row: 14,
      type: "lightWoods"
    }
  ]
};

// src/data/maps/test.json
var test_default = {
  width: 7,
  height: 7,
  terrain: [
    {
      col: 4,
      row: 3,
      type: "heavyWoods"
    },
    {
      col: 5,
      row: 3,
      type: "lightWoods"
    },
    {
      col: 5,
      row: 4,
      type: "lightWoods"
    },
    {
      col: 6,
      row: 4,
      type: "lightWoods"
    }
  ]
};

// src/data/mapschema.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toEngineTerrain(map) {
  return map.terrain.map(({ col, row, type }) => ({ col: col - 1, row: row - 1, type }));
}
function validateMapDef(data) {
  const errors = [];
  if (!isRecord(data)) {
    throw new Error("MapDef must be a JSON object");
  }
  const width = data.width;
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
    errors.push("width must be a positive integer");
  }
  const height = data.height;
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    errors.push("height must be a positive integer");
  }
  const seen = /* @__PURE__ */ new Set();
  const raw = data.terrain;
  if (!Array.isArray(raw)) {
    errors.push("terrain must be an array");
  } else {
    for (const [i, entry] of raw.entries()) {
      const label = `terrain[${i}]`;
      if (!isRecord(entry)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      const col = entry.col;
      const row = entry.row;
      const type = entry.type;
      if (typeof col !== "number" || !Number.isInteger(col)) {
        errors.push(`${label}.col must be an integer`);
      }
      if (typeof row !== "number" || !Number.isInteger(row)) {
        errors.push(`${label}.row must be an integer`);
      }
      if (!isTerrainType(type)) {
        errors.push(`${label}.type ${JSON.stringify(type)} is not clear|lightWoods|heavyWoods`);
      }
      if (typeof col === "number" && typeof row === "number" && typeof width === "number" && typeof height === "number") {
        if (col < 1 || col > width) {
          errors.push(`${label}.col ${col} outside board bounds 1..${width}`);
        }
        if (row < 1 || row > height) {
          errors.push(`${label}.row ${row} outside board bounds 1..${height}`);
        }
        const key = `${col},${row}`;
        if (seen.has(key)) {
          errors.push(`${label} duplicates hex ${key}`);
        } else {
          seen.add(key);
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid MapDef:
  - ${errors.join("\n  - ")}`);
  }
  return data;
}

// src/data/mechs/cda-3ma.json
var cda_3ma_default = {
  model: "CDA-3MA",
  name: "Cicada",
  tonnage: 40,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 8,
  running: 12,
  jumping: 0,
  armor: {
    head: 9,
    centerTorso: 17,
    rightTorso: 15,
    leftTorso: 15,
    rightArm: 12,
    leftArm: 12,
    rightLeg: 20,
    leftLeg: 20
  },
  weapons: [
    { weapon: "Medium Laser", location: "rightArm" },
    { weapon: "Medium Laser", location: "leftArm" },
    { weapon: "Snub-Nose PPC", location: "rightTorso" },
    { weapon: "Small Pulse Laser", location: "centerTorso" }
  ],
  source: "CBT Quick-Start Rules record sheet"
};

// src/data/mechs/enf-4r.json
var enf_4r_default = {
  model: "ENF-4R",
  name: "Enforcer",
  tonnage: 50,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 4,
  running: 6,
  jumping: 0,
  armor: {
    head: 9,
    centerTorso: 23,
    rightTorso: 17,
    leftTorso: 17,
    rightArm: 14,
    leftArm: 14,
    rightLeg: 20,
    leftLeg: 20
  },
  weapons: [
    { weapon: "Autocannon/10", location: "rightArm", ammoShots: 10 },
    { weapon: "Large Laser", location: "leftArm" },
    { weapon: "Small Laser", location: "leftTorso" }
  ],
  source: "CBT Quick-Start Rules record sheet"
};

// src/data/mechs/grf-1n.json
var grf_1n_default = {
  model: "GRF-1N",
  name: "Griffin",
  tonnage: 55,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 5,
  running: 8,
  jumping: 5,
  armor: {
    head: 9,
    centerTorso: 24,
    rightTorso: 18,
    leftTorso: 18,
    rightArm: 18,
    leftArm: 18,
    rightLeg: 20,
    leftLeg: 20
  },
  weapons: [
    { weapon: "LRM 10", location: "rightTorso", ammoShots: 12 },
    { weapon: "PPC", location: "rightArm" }
  ],
  source: "Beginner Box Quick-Start Rules record sheet (armor circles transcribed from TRO 3025 allocation; see TODO.md)"
};

// src/data/mechs/hbk-4g.json
var hbk_4g_default = {
  model: "HBK-4G",
  name: "Hunchback",
  tonnage: 50,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 4,
  running: 6,
  jumping: 0,
  armor: {
    head: 9,
    centerTorso: 26,
    rightTorso: 20,
    leftTorso: 20,
    rightArm: 16,
    leftArm: 16,
    rightLeg: 20,
    leftLeg: 20
  },
  weapons: [
    { weapon: "Autocannon/20", location: "rightTorso", ammoShots: 10 },
    { weapon: "Medium Laser", location: "leftArm" },
    { weapon: "Medium Laser", location: "rightArm" },
    { weapon: "Small Laser", location: "head" }
  ],
  source: "CBT Quick-Start Rules record sheet"
};

// src/data/mechs/her-5sa.json
var her_5sa_default = {
  model: "HER-5SA",
  name: "Hermes II",
  tonnage: 40,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 6,
  running: 9,
  jumping: 0,
  armor: {
    head: 9,
    centerTorso: 16,
    rightTorso: 14,
    leftTorso: 14,
    rightArm: 11,
    leftArm: 11,
    rightLeg: 19,
    leftLeg: 19
  },
  weapons: [
    { weapon: "Large Pulse Laser", location: "rightArm" },
    { weapon: "Flamer", location: "leftArm" },
    { weapon: "Ultra AC/5", location: "rightTorso", ammoShots: 20 }
  ],
  source: "CBT Quick-Start Rules record sheet"
};

// src/data/mechs/wvr-6r.json
var wvr_6r_default = {
  model: "WVR-6R",
  name: "Wolverine",
  tonnage: 55,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 5,
  running: 8,
  jumping: 5,
  armor: {
    head: 9,
    centerTorso: 22,
    rightTorso: 16,
    leftTorso: 16,
    rightArm: 16,
    leftArm: 16,
    rightLeg: 18,
    leftLeg: 18
  },
  weapons: [
    { weapon: "Medium Laser", location: "head" },
    { weapon: "SRM 6", location: "leftTorso", ammoShots: 15 },
    { weapon: "Autocannon/5", location: "rightArm", ammoShots: 20 }
  ],
  source: "Beginner Box Quick-Start Rules record sheet (armor circles transcribed from TRO 3025 allocation; see TODO.md)"
};

// src/data/schema.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireNumber(obj, key, errors) {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${key} must be a finite number`);
    return NaN;
  }
  return v;
}
function validateMechDef(data) {
  const errors = [];
  if (!isRecord2(data)) {
    throw new Error("MechDef must be a JSON object");
  }
  const model = data.model;
  if (typeof model !== "string" || model.length === 0)
    errors.push("model must be a non-empty string");
  const name = data.name;
  if (typeof name !== "string" || name.length === 0) errors.push("name must be a non-empty string");
  const tonnage = requireNumber(data, "tonnage", errors);
  if (Number.isFinite(tonnage) && (tonnage < 10 || tonnage > 100))
    errors.push("tonnage must be 10..100");
  const weightClass = data.weightClass;
  if (weightClass !== "Light" && weightClass !== "Medium" && weightClass !== "Heavy" && weightClass !== "Assault") {
    errors.push("weightClass must be Light|Medium|Heavy|Assault");
  }
  if (typeof data.techBase !== "string") errors.push("techBase must be a string");
  const walking = requireNumber(data, "walking", errors);
  const running = requireNumber(data, "running", errors);
  const jumping = requireNumber(data, "jumping", errors);
  if (Number.isFinite(walking) && Number.isFinite(running) && Number.isFinite(jumping)) {
    if (!Number.isInteger(walking) || walking <= 0)
      errors.push("walking must be a positive integer");
    if (running !== Math.ceil(walking * 1.5)) {
      errors.push(
        `running must equal ceil(walking*1.5) = ${Math.ceil(walking * 1.5)} (quick-start convention)`
      );
    }
    if (!Number.isInteger(jumping) || jumping < 0)
      errors.push("jumping must be a non-negative integer");
  }
  const armorRaw = data.armor;
  if (!isRecord2(armorRaw)) {
    errors.push("armor must be an object keyed by location");
  } else {
    for (const loc of [
      "head",
      "centerTorso",
      "rightTorso",
      "leftTorso",
      "rightArm",
      "leftArm",
      "rightLeg",
      "leftLeg"
    ]) {
      const v = armorRaw[loc];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        errors.push(`armor.${loc} must be a non-negative integer`);
      }
    }
    for (const key of Object.keys(armorRaw)) {
      if (!isLocation(key)) errors.push(`armor.${key} is not a valid location`);
    }
  }
  const weapons = data.weapons;
  if (!Array.isArray(weapons)) {
    errors.push("weapons must be an array");
  } else {
    for (const w of weapons) {
      if (!isRecord2(w)) {
        errors.push("each weapon mount must be an object");
        continue;
      }
      if (typeof w.weapon !== "string") errors.push("weapon.weapon must be a string");
      if (typeof w.location !== "string" || !isLocation(w.location)) {
        errors.push(`weapon.location ${JSON.stringify(w.location)} is not a valid location`);
      }
      const shots = w.ammoShots;
      if (shots !== void 0 && shots !== null) {
        if (typeof shots !== "number" || !Number.isInteger(shots) || shots <= 0) {
          errors.push("weapon.ammoShots must be a positive integer");
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid MechDef (${String(model ?? "?")}):
  - ${errors.join("\n  - ")}`);
  }
  return data;
}

// src/data/weapons.ts
var WEAPONS = {
  "Small Laser": { name: "Small Laser", short: 1, medium: 2, long: 3, damage: 3 },
  "Medium Laser": { name: "Medium Laser", short: 3, medium: 6, long: 9, damage: 5 },
  "Large Laser": { name: "Large Laser", short: 5, medium: 10, long: 15, damage: 8 },
  PPC: { name: "PPC", short: 6, medium: 12, long: 18, damage: 10 },
  "Snub-Nose PPC": {
    name: "Snub-Nose PPC",
    short: 9,
    medium: 13,
    long: 15,
    variableDamage: [10, 8, 5]
  },
  Flamer: { name: "Flamer", short: 1, medium: 2, long: 3, damage: 2, antiInfantry: true },
  "Machine Gun": {
    name: "Machine Gun",
    short: 1,
    medium: 2,
    long: 3,
    damage: 2,
    antiInfantry: true
  },
  "Autocannon/5": { name: "Autocannon/5", short: 6, medium: 12, long: 18, damage: 5 },
  "Autocannon/10": { name: "Autocannon/10", short: 5, medium: 10, long: 15, damage: 10 },
  "Autocannon/20": { name: "Autocannon/20", short: 3, medium: 6, long: 9, damage: 20 },
  "Ultra AC/5": {
    name: "Ultra AC/5",
    short: 6,
    medium: 13,
    long: 20,
    damage: 5,
    rapidFireShots: 2
  },
  "Large Pulse Laser": {
    name: "Large Pulse Laser",
    short: 3,
    medium: 7,
    long: 10,
    damage: 9,
    pulse: true
  },
  "Small Pulse Laser": {
    name: "Small Pulse Laser",
    short: 1,
    medium: 2,
    long: 3,
    damage: 3,
    pulse: true,
    antiInfantry: true
  },
  "LRM 5": { name: "LRM 5", short: 7, medium: 14, long: 21, missileDamage: 1, missiles: 5 },
  "LRM 10": { name: "LRM 10", short: 7, medium: 14, long: 21, missileDamage: 1, missiles: 10 },
  "SRM 6": { name: "SRM 6", short: 3, medium: 6, long: 9, missileDamage: 2, missiles: 6 }
};
function getWeapon(name) {
  const def = WEAPONS[name];
  if (!def) throw new Error(`Unknown weapon: ${name}`);
  return def;
}

// src/data/index.ts
function load(data) {
  return validateMechDef(data);
}
var MECH_DEFS = Object.fromEntries(
  [enf_4r_default, hbk_4g_default, cda_3ma_default, her_5sa_default, grf_1n_default, wvr_6r_default].map((data) => {
    const def = load(data);
    return [def.model, def];
  })
);
function getMechDef(model) {
  return MECH_DEFS[model];
}
var MAP_DEFS = {
  beginner: validateMapDef(beginner_default),
  quickstart: validateMapDef(quickstart_default),
  test: validateMapDef(test_default)
};
function getMapDef(name) {
  return MAP_DEFS[name];
}

// src/rules/arcs.ts
function isInFrontArc(unitFacing, bearingToTarget) {
  return bearingToTarget === unitFacing || bearingToTarget === rotateFacing(unitFacing, 1) || bearingToTarget === rotateFacing(unitFacing, -1);
}

// src/rules/cluster.ts
var CLUSTER_COLUMNS = [2, 5, 6, 10, 15];
var MISSILE_TABLE = [
  [1, 1, 2, 3, 5],
  [1, 2, 2, 3, 5],
  [1, 2, 3, 4, 6],
  [1, 3, 3, 6, 9],
  [1, 3, 4, 6, 9],
  [1, 3, 4, 6, 9],
  [2, 3, 4, 6, 9],
  [2, 4, 5, 8, 12],
  [2, 4, 5, 8, 12],
  [2, 5, 6, 10, 15],
  [2, 5, 6, 10, 15]
];
var SHOT_CLUSTER_COLUMNS = [2, 3, 4];
var SHOTS_TABLE = [
  [1, 1, 2],
  [1, 1, 2],
  [1, 1, 2],
  [1, 2, 2],
  [1, 2, 2],
  [1, 2, 3],
  [2, 2, 3],
  [2, 2, 3],
  [2, 3, 3],
  [2, 3, 4],
  [2, 3, 4]
];
function lookup(table, row, col) {
  const r = table[row - 2];
  if (r === void 0) throw new Error(`Cluster roll out of range: ${row}`);
  const v = r[col];
  if (v === void 0) throw new Error(`Cluster column out of range: ${col}`);
  return v;
}
function clusterHitsForMissiles(missiles, roll2d6) {
  const col = CLUSTER_COLUMNS.indexOf(missiles);
  if (col < 0) throw new Error(`No cluster column for ${missiles} missiles`);
  return lookup(MISSILE_TABLE, roll2d6, col);
}
function clusterHitsForShots(shots, roll2d6) {
  const col = SHOT_CLUSTER_COLUMNS.indexOf(shots);
  if (col < 0) throw new Error(`No shot-cluster column for ${shots} shots`);
  return lookup(SHOTS_TABLE, roll2d6, col);
}
function groupMissiles(total, per) {
  const groups = [];
  let remaining = total;
  while (remaining >= per) {
    groups.push(per);
    remaining -= per;
  }
  if (remaining > 0) groups.push(remaining);
  return groups;
}

// src/rules/damage.ts
var TRANSFER_INWARD = {
  rightArm: "rightTorso",
  leftArm: "leftTorso",
  rightLeg: "rightTorso",
  leftLeg: "leftTorso",
  rightTorso: "centerTorso",
  leftTorso: "centerTorso",
  centerTorso: null,
  head: null
};
function cloneArmor(armor) {
  return { ...armor };
}
function applyDamage(armor, location, damage) {
  if (!Number.isInteger(damage) || damage <= 0) {
    throw new Error(`damage must be a positive integer, got ${damage}`);
  }
  const next = cloneArmor(armor);
  const steps = [];
  const newlyDestroyed = [];
  let blownOffArms = [];
  let killed = false;
  let remaining = damage;
  let current = location;
  while (current !== null && remaining > 0) {
    const cur = current;
    const before = next[cur];
    if (before <= 0) {
      current = TRANSFER_INWARD[cur];
      continue;
    }
    const applied = Math.min(remaining, before);
    const after = before - applied;
    next[cur] = after;
    remaining -= applied;
    const depleted = after === 0;
    steps.push({ location: cur, damageApplied: applied, depleted });
    if (depleted) {
      newlyDestroyed.push(cur);
      if (cur === "head" || cur === "centerTorso") {
        killed = true;
        break;
      }
      if (cur === "rightTorso" && next.rightArm > 0) {
        next.rightArm = 0;
        newlyDestroyed.push("rightArm");
        blownOffArms = [...blownOffArms, "rightArm"];
      }
      if (cur === "leftTorso" && next.leftArm > 0) {
        next.leftArm = 0;
        newlyDestroyed.push("leftArm");
        blownOffArms = [...blownOffArms, "leftArm"];
      }
    }
    if (remaining > 0) {
      current = TRANSFER_INWARD[cur];
    } else {
      break;
    }
  }
  return { armor: next, steps, newlyDestroyed, blownOffArms, killed };
}
function isLocationDestroyed(armor, location) {
  return armor[location] <= 0;
}
function isKilled(armor) {
  return armor.head <= 0 || armor.centerTorso <= 0;
}
function isImmobile(armor) {
  return armor.rightLeg <= 0 || armor.leftLeg <= 0;
}
function canFireFromLocation(armor, location) {
  if (armor[location] <= 0) return false;
  if (location === "rightArm" || location === "rightLeg") return armor.rightTorso > 0;
  if (location === "leftArm" || location === "leftLeg") return armor.leftTorso > 0;
  return true;
}

// src/rules/hitlocation.ts
var HIT_LOCATION_TABLE = {
  2: "centerTorso",
  3: "rightArm",
  4: "rightArm",
  5: "rightLeg",
  6: "rightTorso",
  7: "centerTorso",
  8: "leftTorso",
  9: "leftLeg",
  10: "leftArm",
  11: "leftArm",
  12: "head"
};
function hitLocation(roll2d6) {
  const loc = HIT_LOCATION_TABLE[roll2d6];
  if (loc === void 0) throw new Error(`Hit location roll out of range: ${roll2d6}`);
  return loc;
}

// src/rules/los.ts
function interveningHexes(from, to) {
  return lineHexes(from, to);
}
function losWoodsPoints(intervening) {
  let points = 0;
  for (const t of intervening) points += woodsPoints(t);
  return points;
}
function losBlocked(points) {
  return points >= 3;
}

// src/rules/movement.ts
function maxMovePoints(mode, walking, running, jumping) {
  switch (mode) {
    case "standStill":
      return 0;
    case "walk":
      return walking;
    case "run":
      return running;
    case "jump":
      return jumping;
  }
}
function attackerMovementModifier(mode) {
  switch (mode) {
    case "standStill":
      return 0;
    case "walk":
      return 1;
    case "run":
      return 2;
    case "jump":
      return 3;
  }
}
function targetMovementModifier(hexesEntered, jumped) {
  let mod;
  if (hexesEntered <= 2) mod = 0;
  else if (hexesEntered <= 4) mod = 1;
  else if (hexesEntered <= 6) mod = 2;
  else if (hexesEntered <= 9) mod = 3;
  else if (hexesEntered <= 17) mod = 4;
  else if (hexesEntered <= 24) mod = 5;
  else mod = 6;
  return mod + (jumped ? 1 : 0);
}
function hexesSinceLastReversal(moves) {
  if (moves.length === 0) return 0;
  const last = moves[moves.length - 1];
  let count = 0;
  for (let i = moves.length - 1; i >= 0; i--) {
    if (moves[i] !== last) break;
    count++;
  }
  return count;
}
function facingChangeCost(facings) {
  return facings * MP_PER_FACING_CHANGE;
}
function canPassThroughHex(occupantTeam, moverTeam) {
  return occupantTeam === void 0 || occupantTeam === moverTeam;
}
function canEndMoveInHex(occupantTeam, _moverTeam) {
  return occupantTeam === void 0;
}
function isBackwardStep(from, to, facing) {
  const backHex = neighbor(from, oppositeFacing(facing));
  return backHex.col === to.col && backHex.row === to.row;
}
function isForwardStep(from, to, facing) {
  const ahead = neighbor(from, facing);
  return ahead.col === to.col && ahead.row === to.row;
}
function terrainAt(terrain, hex) {
  return terrain[`${hex.col},${hex.row}`] ?? "clear";
}
function hexKey(hex) {
  return `${hex.col},${hex.row}`;
}

// src/rules/tohit.ts
function rangeBracket(weapon, distance) {
  if (distance <= weapon.short) return "short";
  if (distance <= weapon.medium) return "medium";
  if (distance <= weapon.long) return "long";
  return null;
}
var RANGE_MOD = {
  short: 0,
  medium: 2,
  long: 4
};
function computeToHit(mods) {
  const bracket = rangeBracket(mods.weapon, mods.distance);
  if (bracket === null) {
    return {
      gunnery: mods.gunnery,
      attackerMod: 0,
      targetMod: 0,
      terrainMod: 0,
      rangeMod: 0,
      pulseMod: 0,
      total: Number.POSITIVE_INFINITY,
      rangeBracket: "long",
      automatic: "miss",
      outOfRange: true
    };
  }
  const attackerMod = attackerMovementModifier(mods.attackerMovement);
  const targetMod = targetMovementModifier(mods.targetHexesMoved, mods.targetJumped);
  let terrainMod = mods.interveningWoods;
  terrainMod += mods.targetTerrain === "lightWoods" ? 1 : mods.targetTerrain === "heavyWoods" ? 2 : 0;
  const rangeMod = RANGE_MOD[bracket];
  const pulseMod = mods.weapon.pulse === true ? -2 : 0;
  const total = mods.gunnery + attackerMod + targetMod + terrainMod + rangeMod + pulseMod;
  return {
    gunnery: mods.gunnery,
    attackerMod,
    targetMod,
    terrainMod,
    rangeMod,
    pulseMod,
    total,
    rangeBracket: bracket,
    automatic: total <= 2 ? "hit" : total > 12 ? "miss" : null,
    outOfRange: false
  };
}
function damageForBracket(weapon, bracket) {
  if (weapon.variableDamage !== void 0) {
    return weapon.variableDamage[bracket === "short" ? 0 : bracket === "medium" ? 1 : 2];
  }
  return weapon.damage ?? 0;
}

// src/rules/attack.ts
function resolveWeaponAttack(input) {
  const weapon = getWeapon(input.weaponName);
  const shots = input.shots ?? 1;
  const breakdown = computeToHit({
    gunnery: input.gunnery,
    attackerMovement: input.attackerMoved,
    targetHexesMoved: input.targetHexesMoved,
    targetJumped: input.targetJumped,
    targetTerrain: input.targetTerrain,
    interveningWoods: losWoodsPoints(input.interveningTerrains),
    distance: input.distance,
    weapon
  });
  const base = {
    weapon: weapon.name,
    distance: input.distance,
    breakdown,
    toHitRoll: null,
    hit: false,
    jammed: false,
    clusterRoll: null,
    groups: [],
    application: null
  };
  if (breakdown.outOfRange) return base;
  const roll = roll2D6(input.rng);
  base.toHitRoll = roll;
  const rapidFire = weapon.rapidFireShots !== void 0 && weapon.rapidFireShots > 0;
  if (rapidFire && shots > 1 && roll === 2) base.jammed = true;
  base.hit = breakdown.automatic !== null ? breakdown.automatic === "hit" : roll >= breakdown.total;
  if (!base.hit) return base;
  if (weapon.missiles !== void 0 && weapon.missileDamage !== void 0) {
    const clusterRoll = roll2D6(input.rng);
    base.clusterRoll = clusterRoll;
    const hits = clusterHitsForMissiles(weapon.missiles, clusterRoll);
    if (weapon.missileDamage === 2) {
      for (let i = 0; i < hits; i++) {
        base.groups.push({
          location: hitLocation(roll2D6(input.rng)),
          damage: weapon.missileDamage
        });
      }
    } else {
      for (const lot of groupMissiles(hits, 5)) {
        base.groups.push({
          location: hitLocation(roll2D6(input.rng)),
          damage: lot * weapon.missileDamage
        });
      }
    }
  } else if (rapidFire && shots > 1) {
    const clusterRoll = roll2D6(input.rng);
    base.clusterRoll = clusterRoll;
    const hits = clusterHitsForShots(shots, clusterRoll);
    for (let i = 0; i < hits; i++) {
      base.groups.push({
        location: hitLocation(roll2D6(input.rng)),
        damage: damageForBracket(weapon, breakdown.rangeBracket)
      });
    }
  } else {
    base.groups.push({
      location: hitLocation(roll2D6(input.rng)),
      damage: damageForBracket(weapon, breakdown.rangeBracket)
    });
  }
  let armor = input.targetArmor;
  let application = null;
  for (const group of base.groups) {
    const app = applyDamage(armor, group.location, group.damage);
    armor = app.armor;
    application = application === null ? app : {
      armor: app.armor,
      steps: [...application.steps, ...app.steps],
      newlyDestroyed: [...application.newlyDestroyed, ...app.newlyDestroyed],
      blownOffArms: [...application.blownOffArms, ...app.blownOffArms],
      killed: application.killed || app.killed
    };
  }
  base.application = application;
  return base;
}

// src/rules/initiative.ts
function rollInitiative(teams, rng) {
  if (teams.length < 2) throw new Error("Initiative requires at least two teams");
  const rolls = {};
  let best = [];
  let bestValue = -1;
  do {
    best = [];
    bestValue = -1;
    for (const team of teams) {
      const value = rng.d6() + rng.d6();
      rolls[team] = value;
      if (value > bestValue) {
        bestValue = value;
        best = [team];
      } else if (value === bestValue) {
        best.push(team);
      }
    }
  } while (best.length > 1);
  return { rolls, winnerTeam: best[0] };
}

// src/rules/game.ts
function clone(state) {
  const units = {};
  for (const [id, u] of Object.entries(state.units)) units[id] = { ...u };
  return { ...state, units };
}
function getUnitOrThrow(state, unitId) {
  const unit = state.units[unitId];
  if (!unit) throw new Error(`Unknown unit id: ${unitId}`);
  return unit;
}
function fmtHex(hex) {
  return `${hex.col + 1},${hex.row + 1}`;
}
function requirePhase(state, phase) {
  if (state.phase !== phase) {
    throw new Error(`Expected phase ${phase}, but battle is in ${state.phase}`);
  }
}
function occupantAt(state, hex, excludeId) {
  for (const unit of Object.values(state.units)) {
    if (unit.removed || unit.id === excludeId) continue;
    if (sameHex(unit.position, hex)) return unit;
  }
  return void 0;
}
function createBattle(units, options = {}) {
  if (units.length < 2) throw new Error("A battle needs at least two units");
  const seen = /* @__PURE__ */ new Set();
  for (const init of units) {
    if (seen.has(init.id)) throw new Error(`Duplicate unit id: ${init.id}`);
    seen.add(init.id);
    if (!MECH_DEFS[init.model]) throw new Error(`Unknown 'Mech model: ${init.model}`);
    if (!isFacing(init.facing))
      throw new Error(`Invalid facing for ${init.id}: ${String(init.facing)}`);
    if (!Number.isInteger(init.gunnery) || init.gunnery < 0 || init.gunnery > 7) {
      throw new Error(`Gunnery for ${init.id} must be an integer 0..7`);
    }
  }
  const unitStates = {};
  for (const init of units) {
    const def = MECH_DEFS[init.model];
    const ammoLeft = {};
    def.weapons.forEach((mount, index) => {
      if (mount.ammoShots !== void 0) ammoLeft[index] = mount.ammoShots;
    });
    unitStates[init.id] = {
      id: init.id,
      model: init.model,
      team: init.team,
      gunnery: init.gunnery,
      position: { ...init.position },
      facing: init.facing,
      armor: { ...def.armor },
      phaseStartArmor: { ...def.armor },
      ammoLeft,
      jammedWeapons: [],
      moveMode: null,
      movesThisTurn: [],
      jumpedThisTurn: false,
      mpSpent: 0,
      declaredAttacks: [],
      firedTargetId: null,
      destroyed: false,
      removed: false
    };
  }
  const terrain = {};
  if (options.terrain) {
    for (const { col, row, type } of options.terrain) {
      const key = `${col},${row}`;
      if (key in terrain)
        throw new Error(`Duplicate terrain definition for hex ${fmtHex({ col, row })}`);
      terrain[key] = type;
    }
  }
  for (const [label, n] of [
    ["width", options.width],
    ["height", options.height]
  ]) {
    if (n !== void 0 && (!Number.isInteger(n) || n < 1)) {
      throw new Error(`Board ${label} must be an integer >= 1`);
    }
  }
  return {
    turn: 1,
    phase: "initiative",
    initiativeWinnerTeam: null,
    units: unitStates,
    defs: { ...MECH_DEFS },
    terrain,
    width: options.width,
    height: options.height,
    actedThisPhase: [],
    events: [{ kind: "turn", turn: 1 }]
  };
}
function rollInitiativePhase(state, rng) {
  requirePhase(state, "initiative");
  const next = clone(state);
  const teams = [...new Set(Object.values(next.units).map((u) => u.team))];
  const result = rollInitiative(teams, rng);
  next.initiativeWinnerTeam = result.winnerTeam;
  next.phase = "movement";
  next.events = [
    ...next.events,
    { kind: "initiative", rolls: result.rolls, winnerTeam: result.winnerTeam },
    { kind: "phase", phase: "movement" }
  ];
  return next;
}
function declareMove(state, unitId, mode) {
  requirePhase(state, "movement");
  const next = clone(state);
  const unit = getUnitOrThrow(next, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (mode !== "standStill" && isImmobile(unit.armor)) {
    throw new Error(`${unitId} has a destroyed leg and can only stand still`);
  }
  unit.moveMode = mode;
  unit.movesThisTurn = [];
  unit.mpSpent = 0;
  next.events = [...next.events, { kind: "moveDeclared", unitId, mode }];
  return next;
}
function executeMove(state, unitId, steps, options = {}) {
  requirePhase(state, "movement");
  const next = clone(state);
  const unit = getUnitOrThrow(next, unitId);
  if (unit.moveMode === null) throw new Error(`Declare a movement mode for ${unitId} first`);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  const def = next.defs[unit.model];
  const budget = maxMovePoints(unit.moveMode, def.walking, def.running, def.jumping);
  const jumping = unit.moveMode === "jump";
  let cursor = { ...unit.position };
  let facing = unit.facing;
  let spent = 0;
  const directions = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isFinalStep = i === steps.length - 1;
    if (step.kind === "turn") {
      if (jumping) throw new Error("Jumping 'Mechs choose facing freely on landing; no turn steps");
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids facing changes");
      if (!Number.isInteger(step.facings) || step.facings === 0 || Math.abs(step.facings) > 5) {
        throw new Error("Facing change must be 1..5 hexsides in either direction");
      }
      spent += facingChangeCost(Math.abs(step.facings));
      facing = rotateFacing(facing, step.facings);
      continue;
    }
    const to = step.to;
    if (jumping) {
      let isAdjacent = false;
      for (const f of FACINGS) {
        if (sameHex(neighbor(cursor, f), to)) {
          isAdjacent = true;
          break;
        }
      }
      const jumpInPlace = sameHex(cursor, to);
      if (!isAdjacent && !(jumpInPlace && spent === 0 && directions.length === 0)) {
        throw new Error("Jump steps must enter an adjacent hex (or jump in place once)");
      }
      spent += 1;
      directions.push("forward");
    } else {
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids entering hexes");
      const forward = isForwardStep(cursor, to, facing);
      const backward = !forward && isBackwardStep(cursor, to, facing);
      if (!forward && !backward) {
        throw new Error("Ground moves must go straight ahead or straight back relative to facing");
      }
      if (backward && unit.moveMode === "run") {
        throw new Error("Running 'Mechs cannot move backward");
      }
      spent += costToEnter(terrainAt(next.terrain, to));
      directions.push(forward ? "forward" : "backward");
    }
    const occupant = occupantAt(next, to, unitId);
    if (occupant !== void 0) {
      if (isFinalStep) {
        throw new Error(`Cannot end movement in ${fmtHex(to)}: occupied by ${occupant.id}`);
      }
      if (!jumping && occupant.team !== unit.team) {
        throw new Error(`Cannot move through enemy ${occupant.id} at ${fmtHex(to)}`);
      }
    }
    cursor = { ...to };
  }
  if (spent > budget) {
    throw new Error(`Move costs ${spent} MP but ${unit.moveMode} budget is ${budget}`);
  }
  if (steps.length > 0 && !jumping && unit.moveMode !== "standStill" && isImmobile(unit.armor)) {
    throw new Error(`${unitId} has a destroyed leg and cannot move`);
  }
  unit.position = cursor;
  unit.facing = options.finalFacing ?? facing;
  unit.jumpedThisTurn = jumping && steps.length > 0;
  unit.movesThisTurn = directions;
  unit.mpSpent = spent;
  next.actedThisPhase = [...next.actedThisPhase, unitId];
  next.events = [
    ...next.events,
    {
      kind: "moved",
      unitId,
      mode: unit.moveMode,
      position: { ...cursor },
      facing: unit.facing,
      mpSpent: spent,
      mpBudget: budget
    }
  ];
  return next;
}
function declareAttacks(state, unitId, decls) {
  requirePhase(state, "weaponAttack");
  const next = clone(state);
  const unit = getUnitOrThrow(next, unitId);
  if (unit.destroyed || unit.removed) throw new Error(`${unitId} is destroyed`);
  if (unit.declaredAttacks.length > 0)
    throw new Error(`${unitId} already declared attacks this turn`);
  const def = next.defs[unit.model];
  let targetId = null;
  let attackDistance = 0;
  let attackRangeBracket = "short";
  let attackRangeMod = 0;
  for (const decl of decls) {
    const mount = def.weapons[decl.weaponIndex];
    if (!mount) throw new Error(`weaponIndex ${decl.weaponIndex} out of range for ${unitId}`);
    const weapon = getWeapon(mount.weapon);
    if (unit.jammedWeapons.includes(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is jammed`);
    }
    if (!canFireFromLocation(unit.phaseStartArmor, mount.location)) {
      throw new Error(
        `${mount.weapon} location (${mount.location}) is destroyed or its support torso is gone`
      );
    }
    const shots = decl.shots ?? 1;
    if (!Number.isInteger(shots) || shots < 1) throw new Error("shots must be >= 1");
    if (weapon.rapidFireShots !== void 0 && shots > weapon.rapidFireShots) {
      throw new Error(`${mount.weapon} can fire at most ${weapon.rapidFireShots} shots`);
    }
    if (weapon.rapidFireShots === void 0 && shots > 1) {
      throw new Error(`${mount.weapon} is not rapid-fire`);
    }
    if (targetId === null) targetId = decl.targetId;
    else if (targetId !== decl.targetId) {
      throw new Error("A unit may only declare attacks against one target per turn");
    }
    const target = getUnitOrThrow(next, decl.targetId);
    if (target.removed) throw new Error(`Target ${target.id} is removed from play`);
    if (target.team === unit.team) throw new Error("Target must belong to another team");
    const dist = hexDistance(unit.position, target.position);
    const b = bearing(unit.position, target.position);
    if (b === null) throw new Error("Attacker and target share a hex");
    if (!isInFrontArc(unit.facing, b)) {
      throw new Error(`${mount.weapon}: target not in front firing arc`);
    }
    const intervening = interveningHexes(unit.position, target.position).map(
      (h) => terrainAt(next.terrain, h)
    );
    const woodsPoints2 = intervening.reduce(
      (sum, t) => sum + (t === "lightWoods" ? 1 : t === "heavyWoods" ? 2 : 0),
      0
    );
    if (losBlocked(woodsPoints2)) {
      throw new Error("Line of sight is blocked by intervening woods");
    }
    if (dist > weapon.long) {
      throw new Error(`${mount.weapon}: target at range ${dist} exceeds long range ${weapon.long}`);
    }
    const breakdown = computeToHit({
      gunnery: unit.gunnery,
      attackerMovement: unit.moveMode ?? "standStill",
      targetHexesMoved: hexesSinceLastReversal(target.movesThisTurn),
      targetJumped: target.jumpedThisTurn,
      targetTerrain: terrainAt(next.terrain, target.position),
      interveningWoods: woodsPoints2,
      distance: dist,
      weapon
    });
    if (decls.indexOf(decl) === 0) {
      attackDistance = dist;
      attackRangeBracket = breakdown.rangeBracket;
      attackRangeMod = breakdown.rangeMod;
    }
    if (breakdown.automatic === "miss") {
      throw new Error(
        `${mount.weapon}: modified TN ${breakdown.total} auto-misses; abort the declaration instead`
      );
    }
    const needed = weapon.missiles !== void 0 ? 1 : shots;
    if (mount.ammoShots !== void 0) {
      const left = unit.ammoLeft[decl.weaponIndex] ?? 0;
      if (left < needed) {
        throw new Error(`${mount.weapon}: needs ${needed} shot(s) but only ${left} remain`);
      }
      unit.ammoLeft[decl.weaponIndex] = left - needed;
    }
  }
  if (targetId === null) throw new Error("declareAttacks requires at least one declaration");
  unit.declaredAttacks = [...decls];
  unit.firedTargetId = targetId;
  next.actedThisPhase = [...next.actedThisPhase, unitId];
  next.events = [
    ...next.events,
    {
      kind: "attacksDeclared",
      unitId,
      targetId,
      count: decls.length,
      distance: attackDistance,
      rangeBracket: attackRangeBracket,
      rangeMod: attackRangeMod
    }
  ];
  return next;
}
function resolveDeclaredAttacks(state, unitId, rng) {
  requirePhase(state, "weaponAttack");
  const next = clone(state);
  const unit = getUnitOrThrow(next, unitId);
  if (unit.declaredAttacks.length === 0) throw new Error(`${unitId} has no declared attacks`);
  const def = next.defs[unit.model];
  for (const decl of unit.declaredAttacks) {
    const mount = def.weapons[decl.weaponIndex];
    const weapon = getWeapon(mount.weapon);
    const target = getUnitOrThrow(next, decl.targetId);
    const shots = decl.shots ?? 1;
    const resolution = resolveWeaponAttack({
      rng,
      gunnery: unit.gunnery,
      attackerMoved: unit.moveMode ?? "standStill",
      targetHexesMoved: hexesSinceLastReversal(target.movesThisTurn),
      targetJumped: target.jumpedThisTurn,
      targetTerrain: terrainAt(next.terrain, target.position),
      interveningTerrains: interveningHexes(unit.position, target.position).map(
        (h) => terrainAt(next.terrain, h)
      ),
      distance: hexDistance(unit.position, target.position),
      weaponName: weapon.name,
      shots,
      targetArmor: target.armor
    });
    if (resolution.application !== null) target.armor = resolution.application.armor;
    if (resolution.jammed && !unit.jammedWeapons.includes(decl.weaponIndex)) {
      unit.jammedWeapons = [...unit.jammedWeapons, decl.weaponIndex];
    }
    if (!target.destroyed && isKilled(target.armor)) {
      target.destroyed = true;
      target.removed = true;
      next.events = [
        ...next.events,
        { kind: "unitDestroyed", unitId: target.id },
        { kind: "unitRemoved", unitId: target.id }
      ];
    }
    next.events = [
      ...next.events,
      { kind: "attackResolved", unitId, targetId: target.id, resolution }
    ];
  }
  unit.declaredAttacks = [];
  return next;
}
function advancePhase(state) {
  const next = clone(state);
  let events = [...next.events];
  switch (next.phase) {
    case "initiative": {
      if (next.initiativeWinnerTeam === null) {
        throw new Error("Roll initiative before leaving the initiative phase");
      }
      next.phase = "movement";
      break;
    }
    case "movement": {
      next.phase = "weaponAttack";
      for (const unit of Object.values(next.units)) {
        unit.phaseStartArmor = { ...unit.armor };
      }
      next.actedThisPhase = [];
      break;
    }
    case "weaponAttack": {
      for (const unit of Object.values(next.units)) {
        if (!unit.destroyed && isKilled(unit.armor)) {
          unit.destroyed = true;
          unit.removed = true;
          events = [
            ...events,
            { kind: "unitDestroyed", unitId: unit.id },
            { kind: "unitRemoved", unitId: unit.id }
          ];
        }
      }
      next.phase = "end";
      break;
    }
    case "end": {
      next.turn += 1;
      next.initiativeWinnerTeam = null;
      next.phase = "initiative";
      next.actedThisPhase = [];
      for (const unit of Object.values(next.units)) {
        unit.moveMode = null;
        unit.movesThisTurn = [];
        unit.jumpedThisTurn = false;
        unit.mpSpent = 0;
        unit.declaredAttacks = [];
        unit.firedTargetId = null;
      }
      events = [...events, { kind: "turn", turn: next.turn }];
      break;
    }
  }
  events = [...events, { kind: "phase", phase: next.phase }];
  next.events = events;
  return next;
}
function nextActor(state) {
  if (state.phase !== "movement" && state.phase !== "weaponAttack") return null;
  if (state.initiativeWinnerTeam === null) return null;
  const alive = Object.values(state.units).filter((u) => !u.removed);
  const teams = [...new Set(alive.map((u) => u.team))];
  if (teams.length === 0) return null;
  const winner = state.initiativeWinnerTeam;
  const loser = teams.find((t) => t !== winner) ?? winner;
  const order = loser === winner ? teams : [loser, ...teams.filter((t) => t !== loser)];
  const actedCount = (team) => alive.filter((u) => u.team === team && state.actedThisPhase.includes(u.id)).length;
  const sorted = [...order].sort((a, b) => actedCount(a) - actedCount(b));
  for (const team of sorted) {
    const candidate = alive.find((u) => u.team === team && !state.actedThisPhase.includes(u.id));
    if (candidate) return candidate.id;
  }
  return null;
}
function checkVictory(state) {
  const aliveTeams = new Set(
    Object.values(state.units).filter((u) => !u.removed).map((u) => u.team)
  );
  if (aliveTeams.size <= 1) {
    return { winnerTeam: aliveTeams.values().next().value ?? null, draw: aliveTeams.size === 0 };
  }
  return { winnerTeam: null, draw: false };
}
function getUnit(state, unitId) {
  return getUnitOrThrow(state, unitId);
}
export {
  CLUSTER_COLUMNS,
  FACINGS,
  HIT_LOCATION_TABLE,
  LOCATIONS,
  MAP_DEFS,
  MECH_DEFS,
  MP_PER_FACING_CHANGE,
  MP_TO_ENTER_HEX,
  SHOT_CLUSTER_COLUMNS,
  TERRAIN_TYPES,
  TRANSFER_INWARD,
  WEAPONS,
  advancePhase,
  applyDamage,
  attackerMovementModifier,
  bearing,
  canEndMoveInHex,
  canFireFromLocation,
  canPassThroughHex,
  checkVictory,
  clusterHitsForMissiles,
  clusterHitsForShots,
  computeToHit,
  costToEnter,
  createBattle,
  damageForBracket,
  declareAttacks,
  declareMove,
  executeMove,
  facingChangeCost,
  getMapDef,
  getMechDef,
  getUnit,
  getWeapon,
  groupMissiles,
  hexDistance,
  hexKey,
  hexesSinceLastReversal,
  hitLocation,
  interveningHexes,
  isBackwardStep,
  isFacing,
  isForwardStep,
  isImmobile,
  isInFrontArc,
  isKilled,
  isLocation,
  isLocationDestroyed,
  isTerrainType,
  lineHexes,
  losBlocked,
  losWoodsPoints,
  maxMovePoints,
  neighbor,
  neighbors,
  nextActor,
  oppositeFacing,
  resolveDeclaredAttacks,
  resolveWeaponAttack,
  roll2D6,
  rollD6,
  rollInitiative,
  rollInitiativePhase,
  rotateFacing,
  sameHex,
  targetMovementModifier,
  terrainAt,
  terrainMoveCost,
  toEngineTerrain,
  validateMapDef,
  validateMechDef,
  woodsPoints
};
