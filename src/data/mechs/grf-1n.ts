import type { MechDef } from "../mech.schema.js";

const def: MechDef = {
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
    centerTorso: 27,
    rightTorso: 26,
    leftTorso: 26,
    rightArm: 14,
    leftArm: 14,
    rightLeg: 18,
    leftLeg: 18,
    centerTorsoRear: 7,
    rightTorsoRear: 6,
    leftTorsoRear: 6,
  },
  weapons: [
    {
      weapon: "PPC",
      location: "rightArm",
    },
    {
      weapon: "LRM 10",
      location: "rightTorso",
      shots: 24,
    },
  ],
  critSlots: {
    centerTorso: [
      {
        kind: "structure",
        name: "engine",
      },
      {
        kind: "structure",
        name: "engine",
      },
      {
        kind: "structure",
        name: "engine",
      },
      {
        kind: "structure",
        name: "gyro",
      },
      {
        kind: "structure",
        name: "gyro",
      },
      {
        kind: "structure",
        name: "gyro",
      },
      {
        kind: "structure",
        name: "gyro",
      },
      {
        kind: "structure",
        name: "engine",
      },
      {
        kind: "structure",
        name: "engine",
      },
      {
        kind: "structure",
        name: "engine",
      },
      {
        kind: "structure",
        name: "heatSink",
      },
      {
        kind: "structure",
        name: "jumpJet",
      },
    ],
    leftTorso: [
      {
        kind: "structure",
        name: "jumpJet",
      },
      {
        kind: "structure",
        name: "jumpJet",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    rightTorso: [
      {
        kind: "structure",
        name: "jumpJet",
      },
      {
        kind: "structure",
        name: "jumpJet",
      },
      {
        kind: "weapon",
        weapon: "LRM 10",
      },
      {
        kind: "weapon",
        weapon: "LRM 10",
      },
      {
        kind: "ammo",
        weapon: "LRM 10",
      },
      {
        kind: "ammo",
        weapon: "LRM 10",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    leftArm: [
      {
        kind: "structure",
        name: "shoulder",
      },
      {
        kind: "structure",
        name: "upperArmActuator",
      },
      {
        kind: "structure",
        name: "lowerArmActuator",
      },
      {
        kind: "structure",
        name: "handActuator",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    rightArm: [
      {
        kind: "structure",
        name: "shoulder",
      },
      {
        kind: "structure",
        name: "upperArmActuator",
      },
      {
        kind: "structure",
        name: "lowerArmActuator",
      },
      {
        kind: "structure",
        name: "handActuator",
      },
      {
        kind: "weapon",
        weapon: "PPC",
      },
      {
        kind: "weapon",
        weapon: "PPC",
      },
      {
        kind: "weapon",
        weapon: "PPC",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    leftLeg: [
      {
        kind: "structure",
        name: "hip",
      },
      {
        kind: "structure",
        name: "upperLegActuator",
      },
      {
        kind: "structure",
        name: "lowerLegActuator",
      },
      {
        kind: "structure",
        name: "footActuator",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    rightLeg: [
      {
        kind: "structure",
        name: "hip",
      },
      {
        kind: "structure",
        name: "upperLegActuator",
      },
      {
        kind: "structure",
        name: "lowerLegActuator",
      },
      {
        kind: "structure",
        name: "footActuator",
      },
      {
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    head: [
      {
        kind: "structure",
        name: "lifeSupport",
      },
      {
        kind: "structure",
        name: "sensors",
      },
      {
        kind: "structure",
        name: "cockpit",
      },
      {
        kind: "empty",
      },
      {
        kind: "structure",
        name: "sensors",
      },
      {
        kind: "structure",
        name: "lifeSupport",
      },
    ],
  },
  heatsink: {
    type: "single",
    count: 12,
  },
  source:
    "docs/mtf/Griffin GRF-1N.mtf (TRO 3039 - Age of War). Armor stores front values; rear torso armor kept as 'centerTorsoRear' etc.; shared ammo written on one mount; crit slot table per location included.",
} as const satisfies MechDef;

export default def;
