// 교사 수업 관리 화면 검토 결함(라운드 2: 8·9·12·19·20·21·22)의 회귀 테스트 — 순수 로직, 가상 데이터
//  [8]      종료일을 미래로 정한 수업은 '종료 예정'(그 전까지 운영 중) — courseActiveOn(오늘) 기준
//  [12][21] 담임 반 확인 읽기 실패는 'error'(다시 시도), '담임 아님'('none')으로 위장하지 않음
//  [9][19]  '겹쳐도 추가'는 겹침을 확인한 입력만 보냄 — 패널이 뜬 뒤 입력이 바뀌면 보내지 않음
//  [22]     차시 추가·종료 적용일은 오늘부터(지난 날짜 막기, 서버 code 'past-date' 문구), 확인 대화상자에 영향 문구
//  [20]     수업 목록은 list 응답의 counts만 사용(수업마다 get으로 명단을 받지 않음)
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  acknowledgedRequest,
  addSeriesImpactText,
  buildSeriesAddRequest,
  checkMyHomeroom,
  courseEndState,
  effectiveDateFromIso,
  isPastDateCode,
  listCountsOf,
  PAST_DATE_TEXT,
  retireSeriesImpactText,
  sameSeriesAddRequest,
  type SeriesFormValues,
} from '../../src/lib/timetable/teacherCourseView'
import { courseActiveOn } from '../../src/lib/timetable/engine'
import type { Course } from '../../src/lib/timetable/types'

const TODAY = '20261003'
const course = (extra: Partial<Course> = {}): Course => ({
  courseId: 'c1',
  schoolCode: 'S1',
  termId: '2026-2',
  title: '영어 B',
  subject: '영어',
  teacherUids: ['ty'],
  teacherNames: ['이영어'],
  status: 'active',
  commonForHomerooms: [],
  ...extra,
})

/** 화면 소스(정적 검사용) — 컴파일 위치(.test-dist/tests/unit)와 원본 위치 모두에서 찾음 */
function src(rel: string): string {
  const cands = [path.resolve(__dirname, '../../..', rel), path.resolve(__dirname, '../..', rel), path.resolve(process.cwd(), rel)]
  const f = cands.find((p) => fs.existsSync(p))
  if (!f) throw new Error(`소스 없음: ${rel}`)
  return fs.readFileSync(f, 'utf8')
}

describe('[8] 종료 예정 수업은 종료일 전까지 운영 중', () => {
  test('status ended + 미래 종료일 → 종료 아님, 종료 예정', () => {
    const c = course({ status: 'ended', endedOn: '20261130' })
    const st = courseEndState(c, TODAY)
    assert.equal(st.ended, false)
    assert.equal(st.endScheduled, true)
    assert.equal(st.endedOn, '20261130')
    // 서버(enrollments·invitations·courses)가 쓰는 판정과 같음 — 승인·초대가 서버에서 허용되는 날 화면도 허용
    assert.equal(st.ended, !courseActiveOn(c, TODAY))
  })
  test('종료일 당일·지난 종료일 → 종료', () => {
    assert.deepEqual(courseEndState(course({ status: 'ended', endedOn: TODAY }), TODAY), { ended: true, endScheduled: false, endedOn: TODAY })
    assert.equal(courseEndState(course({ status: 'ended', endedOn: '20260901' }), TODAY).ended, true)
  })
  test('종료일 없는 ended → 종료, 운영 중 수업 → 둘 다 아님', () => {
    assert.deepEqual(courseEndState(course({ status: 'ended', endedOn: null }), TODAY), { ended: true, endScheduled: false, endedOn: null })
    assert.deepEqual(courseEndState(course(), TODAY), { ended: false, endScheduled: false, endedOn: null })
  })
  test('종료일 다음 날이 되면 종료로 바뀜', () => {
    const c = course({ status: 'ended', endedOn: '20261130' })
    assert.equal(courseEndState(c, '20261129').ended, false)
    assert.equal(courseEndState(c, '20261130').ended, true)
  })
  test('화면은 status만으로 종료를 판정하지 않음(상세·목록)', () => {
    for (const f of ['src/pages/teacher/courses/[id].tsx', 'src/pages/teacher/courses/index.tsx']) {
      const s = src(f)
      // 수업(course·c)의 status만 봄 — 수강생(s.status) 표시는 해당 없음
      assert.ok(!/\b(course|c)\.status\s*===\s*'ended'/.test(s), `${f}: 수업 status === 'ended'로 종료 판정`)
      assert.ok(s.includes('courseEndState('), `${f}: courseEndState를 쓰지 않음`)
    }
  })
})

describe('[12][21] 담임 반 확인 실패는 오류로(권한 없음으로 위장하지 않음)', () => {
  const myClass = { grade: 3, classNm: 4, teacherId: 'hr4', schoolCode: 'S1' }

  test('읽기 실패(unavailable) → error, none 아님', async () => {
    const err = Object.assign(new Error('offline'), { code: 'unavailable' })
    const r = await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: async () => Promise.reject(err) })
    assert.equal(r.status, 'error')
    assert.equal(r.status === 'error' && r.error, err)
  })
  test('실제로 읽은 문서로만 none: 담임 아님·문서 없음·수업 그룹', async () => {
    assert.deepEqual(await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'tz', readClass: async () => myClass }), { status: 'none' })
    assert.deepEqual(await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: async () => null }), { status: 'none' })
    assert.deepEqual(await checkMyHomeroom({ homeroomId: 'S1_g_1', uid: 'hr4', readClass: async () => ({ ...myClass, isGroup: true }) }), { status: 'none' })
  })
  test('담임 반이 없으면 읽지 않고 none', async () => {
    let called = 0
    const r = await checkMyHomeroom({ homeroomId: null, uid: 'hr4', readClass: async () => (called++, myClass) })
    assert.deepEqual(r, { status: 'none' })
    assert.equal(called, 0)
  })
  test('내 담임 반 → ok(학년·반 이름)', async () => {
    assert.deepEqual(await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: async () => myClass }), {
      status: 'ok',
      ref: { classId: 'S1_3_4', label: '3학년 4반' },
    })
  })
  test('permission-denied(schoolCode 없는 예전 학급 문서) → 서버 담임 반 목록으로 확인', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'permission-denied' })
    const read = async () => Promise.reject(denied)
    const ok = await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: read, serverHomerooms: async () => [{ classId: 'S1_3_4', label: '3학년 4반' }] })
    assert.deepEqual(ok, { status: 'ok', ref: { classId: 'S1_3_4', label: '3학년 4반' } })
    const none = await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: read, serverHomerooms: async () => [] })
    assert.deepEqual(none, { status: 'none' })
    const failed = await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: read, serverHomerooms: async () => Promise.reject(new Error('net')) })
    assert.equal(failed.status, 'error')
    // 서버 확인 수단이 없으면 권한 오류도 'error'(none으로 위장하지 않음)
    assert.equal((await checkMyHomeroom({ homeroomId: 'S1_3_4', uid: 'hr4', readClass: read })).status, 'error')
  })
  test('상세 화면은 error·loading 상태를 따로 그림', () => {
    const s = src('src/pages/teacher/courses/[id].tsx')
    assert.ok(s.includes("homeroomCheck.status === 'error'"), '오류 상태 표시 없음')
    assert.ok(s.includes('setHomeroomAttempt'), '다시 시도 경로 없음')
    assert.ok(!/setMyHomeroom\(null\)/.test(s), '실패를 null(담임 아님)로 바꾸는 코드가 남아 있음')
  })
})

describe("[9][19] '겹쳐도 추가'는 확인한 입력만 보냄", () => {
  const form = (extra: Partial<SeriesFormValues> = {}): SeriesFormValues => ({
    weekday: 1,
    period: 1,
    start: '',
    end: '',
    roomName: '',
    validFromIso: '',
    ...extra,
  })
  const confirmed = (v: SeriesFormValues) => {
    const b = buildSeriesAddRequest(v, TODAY)
    assert.ok(b.ok)
    return b.req
  }

  test('월 1교시 겹침을 본 뒤 화 3교시로 바꾸면 보내지 않음(null)', () => {
    const seen = confirmed(form())
    assert.equal(acknowledgedRequest(seen, form({ weekday: 2, period: 3 }), TODAY), null)
    assert.equal(acknowledgedRequest(seen, form({ period: 2 }), TODAY), null)
  })
  test('시각·교실·적용 시작일만 바꿔도 다시 확인', () => {
    const seen = confirmed(form({ start: '09:00', end: '09:50', roomName: '3학년 5반 교실' }))
    assert.equal(acknowledgedRequest(seen, form({ start: '10:00', end: '10:50', roomName: '3학년 5반 교실' }), TODAY), null)
    assert.equal(acknowledgedRequest(seen, form({ start: '09:00', end: '09:50', roomName: '과학실' }), TODAY), null)
    assert.equal(acknowledgedRequest(seen, form({ start: '09:00', end: '09:50', roomName: '3학년 5반 교실', validFromIso: '2026-10-12' }), TODAY), null)
  })
  test('같은 입력이면 확인한 그 요청을 그대로 보냄(교실 앞뒤 공백은 같은 값)', () => {
    const seen = confirmed(form({ weekday: 2, period: 3, roomName: '3학년 5반 교실' }))
    const r = acknowledgedRequest(seen, form({ weekday: 2, period: 3, roomName: '  3학년 5반 교실 ' }), TODAY)
    assert.equal(r, seen)
    assert.ok(sameSeriesAddRequest(seen, { ...seen }))
  })
  test('지금 입력이 잘못됐으면(끝 시각만) 보내지 않음', () => {
    const seen = confirmed(form())
    assert.equal(acknowledgedRequest(seen, form({ end: '10:00' }), TODAY), null)
  })
  test('SeriesEditor: 패널 상태에 확인한 입력을 두고, 입력 변경 시 무효화', () => {
    const s = src('src/components/timetable/SeriesEditor.tsx')
    assert.ok(!s.includes('submit(true)'), "'겹쳐도 추가'가 지금 폼 값으로 보내는 submit(true)가 남아 있음")
    assert.ok(s.includes('acknowledgedRequest('), 'acknowledgedRequest를 쓰지 않음')
    // 요일·교시·시작·끝·교실·적용 시작일 6개 입력이 모두 확인을 무효화
    assert.ok((s.match(/formChanged\(\)/g) || []).length >= 6, '입력 변경 시 겹침 확인을 무효화하지 않는 칸이 있음')
  })
})

describe('[22] 지난 날짜 막기·영향 문구', () => {
  test('적용 시작일이 오늘보다 이르면 지난 날짜 오류, 오늘·미래·비움은 허용', () => {
    const base: SeriesFormValues = { weekday: 2, period: 3, start: '', end: '', roomName: '', validFromIso: '' }
    assert.deepEqual(buildSeriesAddRequest({ ...base, validFromIso: '2026-10-02' }, TODAY), { ok: false, error: PAST_DATE_TEXT })
    const t = buildSeriesAddRequest({ ...base, validFromIso: '2026-10-03' }, TODAY)
    assert.ok(t.ok && t.req.validFrom === TODAY)
    const f = buildSeriesAddRequest({ ...base, validFromIso: '2026-11-02' }, TODAY)
    assert.ok(f.ok && f.req.validFrom === '20261102')
    const e = buildSeriesAddRequest(base, TODAY)
    assert.ok(e.ok && e.req.validFrom === null)
  })
  test('종료 적용일: 지난 날짜 오류, 오늘·미래 허용, 비우면 안내', () => {
    assert.deepEqual(effectiveDateFromIso('2026-09-14', TODAY), { ok: false, error: PAST_DATE_TEXT })
    assert.deepEqual(effectiveDateFromIso('2026-10-03', TODAY), { ok: true, ymd: TODAY })
    assert.deepEqual(effectiveDateFromIso('2026-10-10', TODAY), { ok: true, ymd: '20261010' })
    assert.deepEqual(effectiveDateFromIso('', TODAY, '종료 적용일을 골라 주세요.'), { ok: false, error: '종료 적용일을 골라 주세요.' })
  })
  test("서버 400 code 'past-date'도 같은 문구로", () => {
    assert.equal(isPastDateCode('past-date'), true)
    assert.equal(isPastDateCode('past-effective-date'), true)
    assert.equal(isPastDateCode('bad-date'), false)
    assert.equal(isPastDateCode(undefined), false)
  })
  test('확인 대화상자 문구에 영향(이 수업 수강생의 그날 이후 시간표)', () => {
    const r = retireSeriesImpactText('20261012')
    assert.match(r, /10월 12일/)
    assert.match(r, /수강생/)
    assert.match(r, /검토 필요/)
    const a = addSeriesImpactText('20261012')
    assert.match(a, /10월 12일/)
    assert.match(a, /수강생/)
    assert.match(addSeriesImpactText(null), /오늘/)
  })
  test('날짜 입력에 오늘 최소값(min), 차시 추가 전 확인 대화상자', () => {
    const s = src('src/components/timetable/SeriesEditor.tsx')
    assert.ok((s.match(/min=\{todayIso\}/g) || []).length >= 2, '추가·종료 날짜 입력에 min이 없음')
    assert.ok(s.includes('addSeriesImpactText('), '차시 추가 전 영향 확인 없음')
    assert.ok(s.includes('retireSeriesImpactText('), '차시 종료 확인에 영향 문구 없음')
  })
})

describe('[20] 수업 목록 인원은 list 응답 counts만', () => {
  test('counts{active,pending} → 그대로, ended 등 다른 필드는 무시', () => {
    assert.deepEqual(listCountsOf({ courseId: 'c1', counts: { active: 2, pending: 1 } }), { active: 2, pending: 1 })
    assert.deepEqual(listCountsOf({ counts: { active: 0, pending: 0, ended: 5 } }), { active: 0, pending: 0 })
  })
  test("counts가 없거나 모양이 틀리면 null('인원 —')", () => {
    assert.equal(listCountsOf({ courseId: 'c1' }), null)
    assert.equal(listCountsOf({ counts: null }), null)
    assert.equal(listCountsOf({ counts: { active: '2', pending: 1 } }), null)
    assert.equal(listCountsOf({ counts: { active: -1, pending: 0 } }), null)
    assert.equal(listCountsOf({ counts: { active: 1.5, pending: 0 } }), null)
    assert.equal(listCountsOf(null), null)
  })
  test('목록 화면은 수업마다 getCourse(명단·uid 포함)를 부르지 않음', () => {
    const s = src('src/pages/teacher/courses/index.tsx')
    assert.ok(!/\bgetCourse\b/.test(s), 'index.tsx가 getCourse를 씀')
    assert.ok(s.includes('listCountsOf('), 'listCountsOf를 쓰지 않음')
    assert.ok(s.includes('인원 —'), "counts가 없을 때 '인원 —' 표시가 없음")
  })
})
