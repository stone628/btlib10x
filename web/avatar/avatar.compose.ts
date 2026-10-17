/**
 * Avatar box drawing, shared by the creator, the gallery pages and the
 * gallery server functions (no DOM access here).
 */

/** Full-mech box with single borders (side previews). */
export function composeAvatar(
  head: string,
  shoulder: string,
  torso: string,
  arm: string,
  leg: string,
): string[] {
  const sL = shoulder[0] ?? " ";
  const sR = shoulder[1] ?? " ";
  const h = `${head[0] ?? " "}${head[1] ?? " "}`;
  const aL = arm[0] ?? " ";
  const aR = arm[1] ?? " ";
  const t = `${torso[0] ?? " "}${torso[1] ?? " "}`;
  const lL = leg[0] ?? " ";
  const lR = leg[1] ?? " ";
  return ["┌────┐", `│${sL}${h}${sR}│`, `│${aL}${t}${aR}│`, `│ ${lL}${lR} │`, "└────┘"];
}

/** Full-mech box with double borders (selected center). */
export function composeSelectedAvatar(
  head: string,
  shoulder: string,
  torso: string,
  arm: string,
  leg: string,
): string[] {
  const sL = shoulder[0] ?? " ";
  const sR = shoulder[1] ?? " ";
  const h = `${head[0] ?? " "}${head[1] ?? " "}`;
  const aL = arm[0] ?? " ";
  const aR = arm[1] ?? " ";
  const t = `${torso[0] ?? " "}${torso[1] ?? " "}`;
  const lL = leg[0] ?? " ";
  const lR = leg[1] ?? " ";
  return ["╔════╗", `║${sL}${h}${sR}║`, `║${aL}${t}${aR}║`, `║ ${lL}${lR} ║`, "╚════╝"];
}
