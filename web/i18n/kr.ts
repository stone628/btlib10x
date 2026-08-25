import type { Catalog } from "./en.js";

/** Korean catalog. Keys are compile-checked against the English original. */
export const kr: Catalog = {
  // app chrome
  "app.banner.title": "btlib10x 터미널 - 클래식 배틀테크 퀵스타트 규칙",
  "app.banner.help": "명령어는 'help'를 입력하세요.",
  "err.prefix": "오류:",

  // per-state hints (multi-line)
  "hint.setup":
    "'설정(setup)' 단계입니다.\n'map'으로 맵을 불러오고 'add'로 메크를 배치하세요.\n'status'로 편성을 확인하거나 'rm'으로 제거한 뒤 'start'로 전투를 시작하세요.",
  "hint.move":
    "이동 단계입니다 - 프롬프트에 현재 차례가 표시됩니다.\n'mode'로 이동 속도를 선언한 뒤 'move' 또는 'face'로 행동을 추가하고, 'status'로 MP 소비를 확인하세요.\n'done'으로 확정하거나 'cancel'로 취소합니다.",
  "hint.attack":
    "무기 공격 단계입니다 - 프롬프트에 사격 유닛이 표시됩니다.\n'weapons'로 무기를 확인하고 'fire'로 하나의 목표에 대한 사격을 선언하세요.\n'status'로 선언을 확인한 뒤 'done'으로 해결하거나 'cancel'로 취소합니다.",
  "hint.over":
    "전투가 종료되었습니다.\n'rematch'로 같은 편성과 시드로 재대국하거나, 'reset'으로 빈 설정 화면으로 돌아갑니다.",

  // board
  "board.noMap":
    "아직 전장이 없습니다 - 'map'으로 불러오세요. 'info map'에서 목록을 볼 수 있습니다.",

  // lang command
  "lang.current": "언어: {locale}",
  "lang.available": "사용 가능: {list}",
  "lang.set": "언어가 {locale}(으)로 설정되었습니다",
  "err.unknownLocale": "알 수 없는 언어 '{name}' (사용 가능: {list})",

  // help machinery
  "help.usagePrefix": "용법: ",
  "help.argumentsHeader": "인자:",
  "err.unknownCommand": "알 수 없는 명령 '{name}' ('help'를 입력해 보세요)",

  // generic argument parsing
  "err.notInteger": "{label} 값은 정수여야 합니다",
  "err.oneBased": "{label} 값은 1 이상의 정수(1-based)여야 합니다",
  "err.expectedArgs": "용법: {usage}",

  // command help texts
  "cmd.help.help": "현재 단계에서 사용할 수 있는 명령 목록 표시, 또는 특정 명령 설명",
  "cmd.q.help": "help의 별칭",
  "cmd.lang.help": "출력 언어 조회 또는 변경",
  "cmd.lang.arg.locale": "언어 코드; 생략하면 현재 언어 표시",
  "cmd.board.help": "ASCII 전장 격자 그리기",
  "cmd.clear.help": "화면 스크롤백 지우기",
  "cmd.log.help": "최근 N개 이벤트 표시 (기본 10)",
  "cmd.log.arg.n": "표시할 최근 이벤트 개수 (기본 10)",
  "cmd.info.help": "'메크 모델 또는 내장 맵 조회",
  "cmd.info.arg.mech": "HBK-4G 같은 모델 키; 생략하면 전체 목록",
  "cmd.info.arg.map": "내장 맵 이름; 생략하면 전체 목록",
  "cmd.sheet.help": "유닛 레코드 시트 출력",
  "cmd.sheet.arg.id": "유닛 id (설정 단계: 배치된 유닛, 전투 중: 모든 유닛)",
  "cmd.sheetActing.help": "행동 중 메크의 레코드 시트",
  "cmd.seed.help": "주사위 시드 설정",
  "cmd.seed.arg.n": "정수 시드; 같은 시드는 같은 굴림을 재현합니다",
  "cmd.reset.help": "모두 지우고 빈 설정 단계로 초기화",
  "cmd.map.help": "내장 규칙book 맵 불러오기 (beginner|quickstart)",
  "cmd.map.arg.name": "내장 맵 이름: beginner | quickstart",
  "cmd.add.help": "맵에 메크 배치",
  "cmd.add.arg.id": "이후 명령에서 쓰일 고유 유닛 id",
  "cmd.add.arg.model": "메크 모델 키, 'info mech' 참조",
  "cmd.add.arg.team": "팀 번호 (0 또는 1)",
  "cmd.add.arg.gunnery": "조종사 사격 기술; 낮을수록 좋음",
  "cmd.add.arg.colrow": "목표 육각 좌표, 1-based, 맵 내부여야 함",
  "cmd.add.arg.facing": "선택적 방향 n|ne|se|s|sw|nw (기본 n)",
  "cmd.rm.help": "배치된 유닛 제거",
  "cmd.rm.arg.id": "이전에 추가한 유닛의 id",
  "cmd.statusSetup.help": "설정 요약: 팀별 유닛 그룹, 선택된 맵",
  "cmd.start.help": "전투 시작 (2팀 이상, 각 2유닛 이상 필요)",
  "cmd.mode.help": "이동 모드 선언",
  "cmd.mode.arg.mode": "standstill | walk | run | jump; 각각 고유 MP 풀 사용",
  "cmd.move.help": "인접 육각으로 이동 한 칸 예약",
  "cmd.move.arg.colrow": "인접한 목적지 육각, 1-based",
  "cmd.face.help": "방향 변경 예약",
  "cmd.face.arg.facingsteps": "절대 방향 이름, 또는 -5..5 육면 상대 회전; 육면당 MP 1",
  "cmd.statusMove.help": "예약된 이동 단계와 누적 MP 비용",
  "cmd.cancelMove.help": "모드와 예약된 단계 지우기",
  "cmd.doneMove.help": "선언된 이동 확정",
  "cmd.weapons.help": "유닛 무기 목록 (기본: 행동 유닛)",
  "cmd.weapons.arg.id": "조회할 유닛; 생략하면 행동 유닛",
  "cmd.fire.help": "무기 공격 예약",
  "cmd.fire.arg.weaponIndex": "'weapons' 목록의 인덱스",
  "cmd.fire.arg.targetId": "적 유닛 id; 모든 사격은 하나의 목표를 공유해야 함",
  "cmd.fire.arg.shots": "연사 무기(SRM/LRM)의 선택적 발수",
  "cmd.statusAttack.help": "예약된 공격 선언",
  "cmd.cancelFire.help": "예약된 사격 지우기",
  "cmd.doneFire.help": "공격 선언 및 해결",
  "cmd.rematch.help": "같은 편성, 지형, 시드로 새 전투",

  // autoplay demo driver (hidden command, not listed in help)
  "autoPlay.started":
    "autoplay: 데모 전투를 만들어 양측을 자동 진행합니다. 아무 명령이나 입력하면 조종권을 돌려받습니다.",
  "autoPlay.done": "autoplay 종료.",

  // command acknowledgements
  "ok.mapLoaded": "맵 {name}: {w}x{h}, 지형 육각 {n}개",
  "ok.added": "{id} ({model}) 위치 ({col},{row}), 방향 {facing} 배치됨",
  "ok.removed": "{id} 제거됨",
  "ok.started": "전투 시작",
  "ok.modeDeclared": "{id}, {mode} 선언",
  "ok.stepQueued": "({col},{row}) 이동 예약됨",
  "ok.turnQueued": "방향 변경 {steps} 예약됨",
  "ok.cancelled": "취소되었습니다",
  "ok.fireQueued": "#{index} -> {target}{suffix} 예약됨",
  "ok.seedSet": "시드가 {seed}(으)로 설정되었습니다",
  "ok.resetDone": "초기화했습니다.",
  "ok.rematchDone": "재경기!",
  "banner.draw": "=== 무승부 - 남은 유닛 없음 ===",
  "banner.win": "=== 팀 {team} 승리 ===",

  // setup/session errors
  "err.unknownMap": "알 수 없는 맵 {name}; 사용 가능: {list}",
  "err.unknownModel": "알 수 없는 메크 모델: {model} ('info mech' 참조)",
  "err.duplicateId": "유닛 id 중복: {id}",
  "err.badTeam": "team은 음수가 아닌 정수여야 합니다",
  "err.badGunnery": "gunnery는 0..7 범위의 정수여야 합니다",
  "err.hexOccupied": "육각 {col},{row} 은 이미 점유됨",
  "err.noSuchUnit": "그런 유닛이 없습니다: {id}",
  "err.alreadyStarted": "전투가 이미 시작되었습니다",
  "err.needTwoUnits": "전투에는 최소 두 유닛이 필요합니다",
  "err.needTwoTeams": "유닛은 최소 두 팀에 걸쳐 있어야 합니다",
  "err.badModeWord": "mode는 standstill|walk|run|jump 중 하나여야 합니다",
  "err.noBattle": "진행 중인 전투가 없습니다",
  "err.wrongPhase": "이 명령은 {phase} 단계가 필요합니다",
  "err.declareModeFirst": "{id} 유닛의 이동 모드를 먼저 선언하세요 (mode walk|run|jump|standstill)",
  "err.sameHexMove": "다른 육각으로 이동해야 합니다",
  "err.alreadyThere": "이미 그 육각에 있습니다",
  "err.standStillNoEnter": "제자리 대기(standStill)에서는 육각에 진입할 수 없습니다",
  "err.jumpNotAdjacent": "점프 단계는 인접 육각으로 진입해야 합니다",
  "err.groundStraightOnly": "지상 이동은 현재 방향 기준 정면 또는 정면 뒤로만 가능합니다",
  "err.standStillNoFace": "제자리 대기(standStill)에서는 방향을 바꿀 수 없습니다",
  "err.jumpFreeFacing": "점프 착지 시 방향은 자유롭게 선택; 회전 단계 불가",
  "err.badFacings": "방향 변경은 어느 쪽이든 1..5 육면이어야 합니다",
  "err.faceArg": "face는 방향({facings}) 또는 ±1..5 단계 값을 기대합니다",
  "err.faceCurrent": "{facing} 은 현재 방향입니다",
  "err.mpExceeded": "이동에 {spent} MP가 필요하지만 {mode} 예산은 {budget}입니다",
  "err.needsActor": "이 명령에는 행동 유닛이 필요합니다",
  "err.unknownUnitId": "알 수 없는 유닛 id: {id}",
  "err.selfTarget": "목표는 다른 팀이어야 합니다",
  "err.targetRemoved": "목표 {id} 은(는) 게임에서 제외되었습니다",
  "err.oneTarget": "한 유닛은 턴당 하나의 목표에만 공격을 선언할 수 있습니다 (현재 목표: {target})",
  "err.rematchOnlyOver": "전투가 끝난 후에만 사용할 수 있습니다",
  "err.seedInteger": "seed는 정수여야 합니다",
  "err.phaseDriver": "단계 드라이버가 수렴하지 않았습니다",

  // setup status
  "setup.mapLabel": "맵: {name}",
  "setup.mapNone": "(없음)",
  "setup.terrainCount": "지형 육각: {n}",
  "setup.teamHeader": "팀 {team}:",
  "setup.unitLine": "  {id}  {model} ({name}) gunnery {gunnery} @ {pos} 방향 {facing}",
  "setup.noUnits": "(배치된 유닛 없음)",

  // movement status
  "moveStatus.noMode": "(모드 미선언)",
  "moveStatus.mode": "모드: {mode}",
  "moveStatus.budget": "예산: {budget} MP",
  "moveStatus.none": "(예약된 단계 없음)",
  "moveStatus.stepTurn": "{i}. 방향 전환 {steps} ({from} -> {to})",
  "moveStatus.stepEnter": "{i}. 진입 ({col},{row})",
  "moveStatus.stepLine": "{label} +{cost} MP (누계 {total})",

  // attack status
  "attackStatus.none": "(예약된 공격 없음)",
  "weapons.noActorId": "(행동 중 유닛 없음)",

  // record sheet / info
  "info.mechListLine": "{model} {name} ({weightClass}) 걷기/달리기/도약 {walk}/{run}/{jump}",
  "info.head": "{model} {name} — {weightClass} {tonnage}t ({techBase})",
  "info.movement": "이동: 걷기 {walk} / 달리기 {run} / 점프 {jump}",
  "info.mapHead": "{name}: {w}x{h}",
  "info.terrainLine": "지형: {breakdown}",
  "info.terrainNone": "없음",
  "info.legend": "범례: w0 얕은숲  W0 깊은숲  (빈칸 = 평지; 끝 숫자 = 고도)",
  "sheet.head": "{model} {name} — {weightClass} {tonnage}t{gunnery}",
  "sheet.gunnerySuffix": " gunnery {gunnery}",
  "sheet.at": "위치 {pos} 방향 {facing}",
  "sheet.modeSuffix": ", {mode} [mp {mp}]",
  "sheet.removedSuffix": " — 게임 제외됨",
  "sheet.armorLine": "장갑: {list}",
  "sheet.weaponsHeader": "무기 ({n}):",
  "sheet.ammoFlag": "탄약 {n}",
  "sheet.jammed": "[고장]",
  "sheet.destroyed": "[파괴]",

  // event log
  "log.turn": "-- 턴 {turn} --",
  "log.phase": "단계: {phase}",
  "log.initiative": "선제: 팀 {team} 승리 ({rolls})",
  "log.moveDeclared": "{id}, {mode} 선언",
  "log.moved": "{id} {mode} -> {pos} 방향 {facing} [mp {mp}]",
  "log.attacksDeclaredOne": "{id}, {target} 에게 사격 ({count}문)",
  "log.attacksDeclaredOther": "{id}, {target} 에게 사격 ({count}문)",
  "log.destroyed": "*** {id} 파괴됨 ***",
  "log.removedEvent": "{id} 게임 제외",

  // attack resolution
  "res.outOfRange": "사거리 밖",
  "res.outOfRangeLine": "{weapon} @ {distance}: 사거리 밖",
  "res.tn": "TN {total} ({parts})",
  "res.tnAuto": "자동",
  "res.line": "{weapon} @ {distance}: {gator}, 굴림 {roll} -> {verdict}{jam}",
  "res.jamSuffix": " 고장",
  "res.autoHit": "자동명중",
  "res.hit": "명중",
  "res.miss": "빗나감",
  "res.clusterRoll": "클러스터 굴림 {roll}",
  "res.hits": "명중: {groups}",
  "res.blownOff": "; {locs} 파손됨",
  "res.destroyedTail": "; 파괴됨 {locs}",
};
