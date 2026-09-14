import type { MechDef } from "../mech.schema.js";

const def: MechDef = {
  model: "ENF-4R",
  name: "Enforcer",
  tonnage: 50,
  weightClass: "Medium",
  techBase: "Inner Sphere",
  walking: 4,
  running: 6,
  jumping: 4,
  armor: {
    head: 9,
    centerTorso: 27,
    rightTorso: 20,
    leftTorso: 20,
    rightArm: 14,
    leftArm: 14,
    rightLeg: 20,
    leftLeg: 20,
    centerTorsoRear: 4,
    rightTorsoRear: 3,
    leftTorsoRear: 3,
  },
  weapons: [
    {
      weapon: "AC/10",
      location: "rightArm",
      shots: 10,
    },
    {
      weapon: "Large Laser",
      location: "leftArm",
    },
    {
      weapon: "Small Laser",
      location: "leftTorso",
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
        kind: "empty",
      },
      {
        kind: "empty",
      },
    ],
    leftTorso: [
      {
        kind: "structure",
        name: "heatSink",
      },
      {
        kind: "structure",
        name: "heatSink",
      },
      {
        kind: "weapon",
        weapon: "Small Laser",
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
        name: "heatSink",
      },
      {
        kind: "structure",
        name: "heatSink",
      },
      {
        kind: "ammo",
        weapon: "AC/10",
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
        kind: "weapon",
        weapon: "Large Laser",
      },
      {
        kind: "weapon",
        weapon: "Large Laser",
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
        kind: "weapon",
        weapon: "AC/10",
      },
      {
        kind: "weapon",
        weapon: "AC/10",
      },
      {
        kind: "weapon",
        weapon: "AC/10",
      },
      {
        kind: "weapon",
        weapon: "AC/10",
      },
      {
        kind: "weapon",
        weapon: "AC/10",
      },
      {
        kind: "weapon",
        weapon: "AC/10",
      },
      {
        kind: "weapon",
        weapon: "AC/10",
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
        kind: "structure",
        name: "jumpJet",
      },
      {
        kind: "structure",
        name: "jumpJet",
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
        kind: "structure",
        name: "jumpJet",
      },
      {
        kind: "structure",
        name: "jumpJet",
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
    "docs/mtf/Enforcer ENF-4R.mtf (TRO 3039 - Star League). Armor stores front values; rear torso armor kept as 'centerTorsoRear' etc.; shared ammo written on one mount; crit slot table per location included.",
} as const satisfies MechDef;

export default def;
