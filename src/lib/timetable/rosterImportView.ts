/**
 * 수강 명단 올리기 화면(/teacher/roster-import)의 순수 판정 도우미
 * (React·Firebase와 분리 — 단위 테스트 대상. importRows.ts는 브라우저 File 타입을 쓰므로 여기서 import하지 않음)
 *
 * - '읽지 못한 행 빼고 계속하기' 동의: 동의할 때 본 파일·시트·머리글 행·열 매핑에만 유효 — 하나라도 바뀌면 다시 동의
 * - 미리보기(stage) 결과: 미리보기를 만든 입력(위 + 적용 시작일·학기)과 지금 입력이 다르면 저장하지 않음(다시 미리보기)
 *   저장(commit)은 batchId만 보내므로, 서버에는 미리보기 때 값이 저장됨 — 화면 입력과 다르면 엉뚱한 날짜·학기로 저장됐음
 */

/** 읽지 못한 행을 정하는 입력 — 이 중 하나라도 바뀌면 읽지 못한 행 목록이 달라질 수 있음 */
export interface RosterSourceInput {
  fileHash: string
  /** 시트 고유 이름(WorkbookSheet.name) */
  sheetName: string
  headerRow: number
  /** 열 매핑(importRows.RosterMapping — 항목 → 0부터 센 열 번호, 없으면 null) */
  mapping: object
}

/** 미리보기(stage) 요청에 들어가는 입력 */
export interface RosterStageInput extends RosterSourceInput {
  validFrom: string
  /** 화면 입력 그대로(비우면 서버가 적용 시작일로 학기를 정함) */
  termId: string
}

// 열 매핑은 항목 순서와 상관없이 같은 값이면 같은 키(머리글 제안과 교사 수정의 객체 키 순서가 달라도)
// 비운 항목(null)과 없는 항목은 같음 — 둘 다 '그 열 안 씀'
const mappingKey = (m: object): string =>
  Object.entries(m)
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(',')

export function rosterSourceKey(s: RosterSourceInput): string {
  return JSON.stringify([s.fileHash, s.sheetName, s.headerRow, mappingKey(s.mapping)])
}

export function rosterStageKey(s: RosterStageInput): string {
  return JSON.stringify([rosterSourceKey(s), s.validFrom, s.termId.trim()])
}

/** '읽지 못한 행 빼고 계속하기' 동의가 지금 입력에 유효한지 — 동의할 때 저장한 키와 지금 키가 같아야 함 */
export function skipConsentValid(consentKey: string | null, currentSourceKey: string): boolean {
  return consentKey !== null && consentKey === currentSourceKey
}

/** 미리보기 만들기를 할 수 있는지 — 읽지 못한 행이 있으면 지금 입력에 대한 동의가 있어야 함 */
export function canStageRoster(p: { rowCount: number; tooMany: boolean; badRowCount: number; consentKey: string | null; sourceKey: string }): boolean {
  if (p.rowCount === 0 || p.tooMany) return false
  return p.badRowCount === 0 || skipConsentValid(p.consentKey, p.sourceKey)
}

/** 미리보기 결과가 지금 입력과 맞지 않음(미리보기 뒤 적용 시작일·학기·매핑 등을 바꿈) — 저장 막고 다시 미리보기 */
export function stagedIsStale(stagedKey: string | null, currentStageKey: string): boolean {
  return stagedKey !== currentStageKey
}
