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
  { name: "iv", data: "∈∋", desc: "inset visor" },
  { name: "ivb", data: "⋶⋽", desc: "inset visor eyebrow" },
  { name: "ivc", data: "⋳⋻", desc: "inset visor cyclops" },
  { name: "ivw", data: "⋲⋺", desc: "inset visor wide" },
  { name: "bw", data: "⊑⊒", desc: "flat visor" },
  { name: "hr", data: "⎧⎫", desc: "high round" },
  { name: "hq", data: "⎡⎤", desc: "high square" },
];

/**
 * Shoulder pair: 2 chars, [left, right] wrap the head as S H H S.
 * Symmetric pairs render the same glyph both sides; asymmetric pairs
 * (e.g. `\/`) mirror inward.
 */
export const SHOULDERS: PartVariant[] = [
  { name: "no", data: "  ", desc: "no shoulder" },
  { name: "rn", data: "╭╮", desc: "round" },
  { name: "sq", data: "┌┐", desc: "square" },
  { name: "sw", data: "╓╖", desc: "square wide" },
  { name: "st", data: "╒╕", desc: "square tall" },
  { name: "dl", data: "╔╗", desc: "dual layer" },
  { name: "sd", data: "⊑⊒", desc: "square double" },
  { name: "rd", data: "⊆⊇", desc: "round double" },
  { name: "rp", data: "()", desc: "round pod" },
  { name: "bp", data: "[]", desc: "block pod" },
  { name: "wg", data: "<>", desc: "wedge" },
  { name: "ws", data: "≤≥", desc: "wedge stable" },
  { name: "wd", data: "≦≧", desc: "wedge double" },
  { name: "hr", data: "⎧⎫", desc: "high round" },
  { name: "hq", data: "⎡⎤", desc: "high square" },
  { name: "l1", data: "⚀⚀", desc: "missile-launcher 1" },
  { name: "l2", data: "⚁⚁", desc: "missile-launcher 2" },
  { name: "l3", data: "⚂⚂", desc: "missile-launcher 3" },
  { name: "l4", data: "⚃⚃", desc: "missile-launcher 4" },
  { name: "l5", data: "⚄⚄", desc: "missile-launcher 5" },
  { name: "l6", data: "⚅⚅", desc: "missile-launcher 6" },
  { name: "m3u", data: "∴∴", desc: "missile 3up" },
  { name: "m3d", data: "∵∵", desc: "missile 3down" },
  { name: "m4", data: "⁘⁘", desc: "missile 4" },
  { name: "m5", data: "⁙⁙", desc: "missile 5" },
];

/** Torso core: 2 chars, sits as TT in │ATTA│. */
export const TORSOS: PartVariant[] = [
  { name: "rs", data: "()", desc: "round" },
  { name: "sl", data: ")(", desc: "slim" },
  { name: "bs", data: "[]", desc: "block" },
  { name: "st", data: "][", desc: "straw" },
  { name: "by", data: "{}", desc: "belly" },
  { name: "cy", data: "}{", desc: "curly" },
  { name: "as", data: "<>", desc: "angular" },
  { name: "hb", data: "⎡⎤", desc: "heavy block" },
  { name: "sb", data: "⌈⌉", desc: "slim block" },
  { name: "bt", data: "├┤", desc: "belt" },
  { name: "bo", data: "┼┼", desc: "belt out" },
  { name: "db", data: "╞╡", desc: "double belt" },
  { name: "dbo", data: "╪╪", desc: "double belt out" },
  { name: "pb", data: "╟╢", desc: "protected belt" },
  { name: "pbo", data: "╫╫", desc: "protected belt out" },
  { name: "fb", data: "╠╣", desc: "full belt" },
  { name: "fbo", data: "╬╬", desc: "full belt out" },
  { name: "ts", data: "╥╥", desc: "twin stack" },
  { name: "ss", data: "┬┬", desc: "single stack" },
  { name: "cf", data: "⌈⌉", desc: "clamshell" },
  { name: "jf", data: "⎨⎬", desc: "jointed" },
  { name: "cb", data: "⎬⎨", desc: "choking belt" },
];

/** Arm pair: 2 chars, [left, right] wrap the torso as A T T A. */
export const ARMS: PartVariant[] = [
  { name: "ss", data: "╵╵", desc: "short slim" },
  { name: "sb", data: "╹╹", desc: "short bold" },
  { name: "ps", data: "┘└", desc: "palm short" },
  { name: "pr", data: "╯╰", desc: "palm round" },
  { name: "fg", data: "╛╘", desc: "fingers" },
  { name: "pb", data: "╜╙", desc: "palm bold" },
  { name: "fb", data: "╝╚", desc: "fingers bold" },
  { name: "hs", data: "└┘", desc: "hook short" },
  { name: "hr", data: "╰╯", desc: "hook round" },
  { name: "cs", data: "╘╛", desc: "chopsticks" },
  { name: "hb", data: "╙╜", desc: "hook bold" },
  { name: "csb", data: "╚╝", desc: "chopsticks bold" },
  { name: "st", data: "||", desc: "straight" },
  { name: "rp", data: "()", desc: "round" },
  { name: "ro", data: ")(", desc: "round out" },
  { name: "bp", data: "[]", desc: "block" },
  { name: "cb", data: "][", desc: "claw bar" },
  { name: "cd", data: "{}", desc: "scythe" },
  { name: "gp", data: "╞╡", desc: "gun pod" },
  { name: "rt", data: "╫╫", desc: "rotary" },
];

/** Leg pair: 2 chars, [left, right] render centered as │ LL │. */
export const LEGS: PartVariant[] = [
  // { name: "st", data: "||", desc: "standard" },
  // { name: "bd", data: "[]", desc: "block" },
  // { name: "rd", data: "()", desc: "round" },
  // { name: "sl", data: "//", desc: "sloped" },
  // { name: "tp", data: "\\/", desc: "tapered" },
  // { name: "fl", data: "/\\", desc: "flared" },
  // { name: "jt", data: "╞╡", desc: "jointed" },
  // { name: "rt", data: "╫╫", desc: "rotary" },
  // { name: "ps", data: "==", desc: "piston" },
  // { name: "cl", data: "<>", desc: "digitigrade" },
  // { name: "op", data: "OO", desc: "roller" },
  { name: "ss", data: "╵╵", desc: "short slim" },
  { name: "sb", data: "╹╹", desc: "short bold" },
  { name: "sf", data: "┘└", desc: "short feet" },
  { name: "sr", data: "╯╰", desc: "short round" },
  { name: "bf", data: "╜╙", desc: "bold feet" },
  { name: "tf", data: "╛╘", desc: "thick feet" },
  { name: "st", data: "╝╚", desc: "short thick" },
  { name: "bd", data: "[]", desc: "block" },
  { name: "br", data: "][", desc: "block reverse" },
  { name: "rd", data: "()", desc: "round" },
  { name: "rr", data: ")(", desc: "round reverse" },
];
