import type { MechDef } from "../mech.schema";

const def: MechDef = {
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
    centerTorso: 23,
    rightTorso: 20,
    leftTorso: 20,
    rightArm: 12,
    leftArm: 12,
    rightLeg: 20,
    leftLeg: 20,
    centerTorsoRear: 6,
    rightTorsoRear: 5,
    leftTorsoRear: 5,
  },
  weapons: [
    {
      weapon: "Medium Laser",
      location: "rightTorso",
    },
    {
      weapon: "Snub-Nose PPC",
      location: "leftTorso",
    },
    {
      weapon: "Medium Laser",
      location: "leftTorso",
    },
    {
      weapon: "Small Pulse Laser",
      location: "centerTorso",
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
        kind: "weapon",
        weapon: "Small Pulse Laser",
      },
      {
        kind: "empty",
      },
    ],
    leftTorso: [
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
        kind: "weapon",
        weapon: "Snub-Nose PPC",
      },
      {
        kind: "weapon",
        weapon: "Snub-Nose PPC",
      },
      {
        kind: "weapon",
        weapon: "Medium Laser",
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
        kind: "weapon",
        weapon: "Medium Laser",
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
    type: "double",
    count: 10,
  },
  source:
    "docs/mtf/Cicada CDA-3MA.mtf (TRO 3050 - Jihad). Armor stores front values; rear torso armor kept as 'centerTorsoRear' etc.; shared ammo written on one mount; crit slot table per location included.",
} as const satisfies MechDef;

export default def;
