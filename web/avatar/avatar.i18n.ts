import type { SlotId } from "./avatar.override";

/**
 * UI strings the creator builds in script. Static page text lives in
 * avatar.html as paired `<span lang>` elements, like the landing page; the
 * locale itself is `<html lang>`, set by the inline script in avatar.html
 * (?lang=, then localStorage "bt10x.lang", then English).
 *
 * Preset names and descriptions (avatar.data.ts), Unicode block names in the
 * picker and the export line (`HEAD=bv ...`) stay as they are in both locales.
 */
const en = {
  title: "bt10x mech avatar creator",
  part: {
    head: "HEAD",
    shoulder: "SHOULDER",
    torso: "TORSO",
    arms: "ARMS",
    legs: "LEGS",
  } as Record<string, string>,
  slot: {
    RH: "right head",
    LH: "left head",
    RS: "right shoulder",
    LS: "left shoulder",
    RA: "right arm",
    LA: "left arm",
    RT: "right torso",
    LT: "left torso",
    RL: "right leg",
    LL: "left leg",
  } as Record<SlotId, string>,
  slotSet: (slot: string, cp: string) => `, ${slot} set to ${cp}`,
  variants: (part: string) => `${part} variants`,
  previous: (part: string) => `previous ${part}`,
  next: (part: string) => `next ${part}`,
  selected: (part: string, name: string) => `${part} ${name} selected`,
  blank: "blank",
  override: "override",
  fromVariant: "from variant",
  copied: "avatar copied to clipboard",
  linkCopied: "link copied to clipboard",
  copyFailed: "copy failed: clipboard unavailable",
  pickerLabel: (slot: string) => `choose a character for ${slot}`,
  group: "group ",
  find: "find ",
  findPlaceholder: "paste a char or U+2622",
  recent: "recent · hold to pin",
  recentLabel: "recent and pinned; hold or press P to pin",
  pinnedTitle: (cp: string) => `${cp} (pinned)`,
  pinnedLabel: (cp: string) => `${cp}, pinned`,
  pinned: "pinned",
  unpinned: "unpinned",
  useVariant: "use variant",
  cancel: "cancel",
  apply: "apply",
  applyWhat: (what: string) => `apply ${what}`,
  variantGlyph: (ch: string) => `variant ${ch}`,
  notInFont: (cp: string) => `${cp} not in font`,
};

export type AvatarMessages = typeof en;

const ko: AvatarMessages = {
  title: "bt10x 'Mech 아바타 생성기",
  part: { head: "머리", shoulder: "어깨", torso: "몸통", arms: "팔", legs: "다리" },
  slot: {
    RH: "오른쪽 머리",
    LH: "왼쪽 머리",
    RS: "오른쪽 어깨",
    LS: "왼쪽 어깨",
    RA: "오른팔",
    LA: "왼팔",
    RT: "오른쪽 몸통",
    LT: "왼쪽 몸통",
    RL: "오른다리",
    LL: "왼다리",
  },
  slotSet: (slot, cp) => `, ${slot}: ${cp} 지정`,
  variants: (part) => `${part} 변형`,
  previous: (part) => `이전 ${part}`,
  next: (part) => `다음 ${part}`,
  selected: (part, name) => `${part} ${name} 선택됨`,
  blank: "빈칸",
  override: "덮어씀",
  fromVariant: "변형 기본값",
  copied: "아바타를 클립보드에 복사했습니다",
  linkCopied: "링크를 클립보드에 복사했습니다",
  copyFailed: "복사 실패: 클립보드를 사용할 수 없습니다",
  pickerLabel: (slot) => `${slot}에 쓸 문자 선택`,
  group: "그룹 ",
  find: "찾기 ",
  findPlaceholder: "문자 또는 U+2622",
  recent: "최근 · 길게 눌러 고정",
  recentLabel: "최근 및 고정; 길게 누르거나 P를 눌러 고정",
  pinnedTitle: (cp) => `${cp} (고정됨)`,
  pinnedLabel: (cp) => `${cp}, 고정됨`,
  pinned: "고정됨",
  unpinned: "고정 해제됨",
  useVariant: "변형 사용",
  cancel: "취소",
  apply: "적용",
  applyWhat: (what) => `${what} 적용`,
  variantGlyph: (ch) => `변형 ${ch}`,
  notInFont: (cp) => `${cp}: 글꼴에 없음`,
};

/** Strings for the current `<html lang>`; anything but `ko` reads English. */
export function msg(): AvatarMessages {
  return document.documentElement.lang === "ko" ? ko : en;
}
