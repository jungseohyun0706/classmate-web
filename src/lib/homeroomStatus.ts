/**
 * 학생 소속 학급 상태 표시 판단 — 순수 함수(브라우저·Firebase 없이 단위 테스트: tests/unit/timetable-client.test.ts)
 *
 * '소속 없음'과 '승인 대기'는 다른 상태입니다(R01).
 * 수업 초대로 처음 가입한 학생은 users/{uid}가 { status: 'pending', classId: null }로 만들어지지만
 * 기다리는 학급 신청이 없으므로 '선생님 승인을 기다리고 있어요'를 보여 주지 않습니다.
 * 수업별 승인 대기는 수업 카드(○○ 수업 승인을 기다리고 있어요)가 따로 보여 줍니다.
 */

export interface HomeroomProfileLike {
  classId?: string | null
  status?: string | null
}

/**
 * 학급(또는 예전 수업 그룹 _g_) 신청이 담임 승인을 기다리는 중인지.
 * status가 pending이어도 classId가 없으면(수업 초대로만 가입) false.
 */
export function awaitingHomeroomApproval(p: HomeroomProfileLike | null | undefined): boolean {
  if (!p || p.status !== 'pending') return false
  return typeof p.classId === 'string' && p.classId.trim() !== ''
}
