export interface PartVariant {
  name: string;
  data: string;
  desc: string;
}

/** Head core: 2 chars, sits as HH in │SHHS│. */
export const HEADS: PartVariant[] = [
  { name: "sr", data: "╭╮", desc: "small round" },
  { name: "sq", data: "┌┐", desc: "small square" },
  { name: "rv", data: "()", desc: "round visor" },
  { name: "bv", data: "[]", desc: "block visor" },
  { name: "cv", data: "{}", desc: "curly visor" },
  { name: "av", data: "<>", desc: "angular visor" },
  { name: "cw", data: "⊆⊇", desc: "clamped visor" },
  { name: "ew", data: "∈∋", desc: "inset visor" },
  { name: "bw", data: "⊑⊒", desc: "flat visor" },
  { name: "oo", data: "OO", desc: "twin optics" },
  { name: "xx", data: "><", desc: "crossed visor" },
  { name: "tf", data: "╫╫", desc: "twin feed" },
];

/**
 * Shoulder pair: 2 chars, [left, right] wrap the head as S H H S.
 * Symmetric pairs render the same glyph both sides; asymmetric pairs
 * (e.g. `\/`) mirror inward.
 */
export const SHOULDERS: PartVariant[] = [
  { name: "ss", data: "SS", desc: "slab" },
  { name: "rd", data: "╭╮", desc: "round" },
  { name: "sq", data: "┌┐", desc: "square" },
  { name: "rp", data: "()", desc: "round pod" },
  { name: "bp", data: "[]", desc: "block pod" },
  { name: "wg", data: "<>", desc: "wedge" },
  { name: "sl", data: "//", desc: "sloped" },
  { name: "tp", data: "\\/", desc: "tapered" },
  { name: "fl", data: "/\\", desc: "flared" },
  { name: "rt", data: "╫╫", desc: "rotary" },
  { name: "op", data: "OO", desc: "optic pod" },
];

/** Torso core: 2 chars, sits as TT in │ATTA│. */
export const TORSOS: PartVariant[] = [
  { name: "rs", data: "()", desc: "round" },
  { name: "bs", data: "[]", desc: "block" },
  { name: "cs", data: "{}", desc: "curly" },
  { name: "as", data: "<>", desc: "angular" },
  { name: "hb", data: "⎡⎤", desc: "heavy block" },
  { name: "fb", data: "╞╡", desc: "gun block" },
  { name: "rf", data: "╫╫", desc: "rotary feed" },
  { name: "pf", data: "╥╥", desc: "twin stack" },
  { name: "vf", data: "┬┬", desc: "vented" },
  { name: "cf", data: "⌈⌉", desc: "clamshell" },
  { name: "jf", data: "⎨⎬", desc: "jointed" },
  { name: "of", data: "OO", desc: "twin optic" },
];

/** Arm pair: 2 chars, [left, right] wrap the torso as A T T A. */
export const ARMS: PartVariant[] = [
  { name: "st", data: "AA", desc: "standard" },
  { name: "ps", data: "||", desc: "piston" },
  { name: "rp", data: "()", desc: "round" },
  { name: "bp", data: "[]", desc: "block" },
  { name: "cl", data: "{}", desc: "claw" },
  { name: "bl", data: "<>", desc: "blade" },
  { name: "sl", data: "//", desc: "slash" },
  { name: "gp", data: "╞╡", desc: "gun pod" },
  { name: "rt", data: "╫╫", desc: "rotary" },
  { name: "op", data: "OO", desc: "optic" },
  { name: "tp", data: "\\/", desc: "tapered" },
];

/** Leg pair: 2 chars, [left, right] render centered as │ LL │. */
export const LEGS: PartVariant[] = [
  { name: "st", data: "||", desc: "standard" },
  { name: "bd", data: "[]", desc: "block" },
  { name: "rd", data: "()", desc: "round" },
  { name: "sl", data: "//", desc: "sloped" },
  { name: "tp", data: "\\/", desc: "tapered" },
  { name: "fl", data: "/\\", desc: "flared" },
  { name: "jt", data: "╞╡", desc: "jointed" },
  { name: "rt", data: "╫╫", desc: "rotary" },
  { name: "ps", data: "==", desc: "piston" },
  { name: "cl", data: "<>", desc: "digitigrade" },
  { name: "op", data: "OO", desc: "roller" },
];
