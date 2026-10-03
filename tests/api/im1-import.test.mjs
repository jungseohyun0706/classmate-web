// 통합 테스트: /api/timetable-import — stage → preview → commit → 재업로드 → 수정본 → 검토 제외 → 원복
//   + 정책(IM3): 공통 수업은 담임 확인(/api/courses setCommon)만, 교사 계정 연결은 발행 교사가 확인한 후보(confirmTeacherUids)만
//   + 검토 결함 회귀: 연결 확인은 (엑셀 이름, 계정) 쌍(confirmTeacherLinks), 수강 변경(scheduleRevision +1)만으로는 발행이 막히지 않음,
//     발행 도중 끊긴 배치('committing', 임대 만료)를 이어서 발행·원복
// 대상: 실제 Next 서버(BASE, 기본 http://127.0.0.1:3100) + 로컬 에뮬레이터(8080/9099) + NEIS mock. 운영 프로젝트에 연결하지 않습니다.
// 함께 부르는 API: /api/timetable/me(학생 시간표), /api/courses(setCommon·get), /api/schedule-changes(preview·list)
// 데이터는 모두 가상입니다(tests/fixtures/import/*.json note 참고).
// 실행: node tests/api/im1-import.test.mjs   (서버를 NEXT_PUBLIC_USE_EMULATORS=1, 에뮬레이터 환경으로 띄운 뒤)
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { wipe, createUsers, clientSession, api, reporter, admin, Timestamp, FieldValue, require as req } from '../e2e/lib/env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fx = (name) => JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures/import', name), 'utf8'))
const THREE = fx('three-sources.json')
const AMB = fx('ambiguous.json')
const S = 'S1'
const TERM = THREE.termId // 2026-2 (학기 문서 없음 → 기본 학기)
const X1 = THREE.validFrom // 20260907 (월)
const X2 = '20261005'
const TUE1 = '20260908' // X1 주 화요일
const THU1 = '20260910' // X1 주 목요일
const API = '/api/timetable-import'
const ME = `/api/timetable/me?from=${X1}&to=20260913`

const K_KOR34 = 'hr|3-4|국어|김민수'
const K_KOR35 = 'hr|3-5|국어|김민수'
const K_ENGA = 'sec|영어|A|이영희'
const K_ENGB = 'sec|영어|B|정하늘'
const K_MUSIC = 'hr|3-4|음악|최유나'

const KIM = 'im1-t-kim' // 발행 교사(김민수)
const LEE = 'im1-t-lee' // 영어 A 교사(이영희)
const CHOI = 'im1-t-choi' // 음악 교사(최유나)
const HR4 = 'im1-t-hr4' // 3-4 담임(과목 수업 없음)
const EVIL = 'im1-t-evil' // 다른 교사 이름을 masterName으로 정하는 교사
const S2KIM = 'im1-t-s2kim' // 다른 학교 김민수
const STA = 'im1-st-a' // 3-4 학생
const P1 = 'im1-t-p1' // 연결 쌍 확인: 엑셀 이름 '김철수' 계정(미리보기 뒤 masterName을 '박영희'로 바꿈)
const P2 = 'im1-t-p2' // 연결 쌍 확인: 엑셀 이름 '박영희' 계정

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
const key = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const shuffled = (arr, seed) => {
  const out = arr.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
/** 수정본: 음악 장소 변경(세 자료 모두) + 3-5 국어 목 1교시 → 목 3교시 (단위 테스트와 같은 변형) */
const revisedRows = () =>
  THREE.rows.map((r) => {
    const x = { ...r }
    if (key(x.subject) === '음악') x.room = x.room ? '음악실2' : x.room
    if (x.sourceKind === 'room' && key(x.subject) === '음악') x.sheet = '특별실시간표#음악실2'
    if (key(x.subject) === '국어' && x.weekday === 4 && x.period === 1) x.period = 3
    return x
  })

const R = reporter('im1-import')
const { check, note } = R
const { db } = admin()
const sref = db.collection('schools').doc(S)
const revisionNow = async () => Number((await sref.get()).get('scheduleRevision') || 0)
const stageBody = (rows, extra = {}) => ({
  action: 'stage',
  schoolCode: S,
  termId: TERM,
  validFrom: X1,
  mode: 'merge',
  fileName: '가상-시간표.xlsx',
  fileHash: sha(rows),
  rows,
  ...extra,
})
const courseByKey = async (importKey) => {
  const q = await sref.collection('courses').where('importKey', '==', importKey).get()
  return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() }
}
const seriesOf = async (courseId) => (await sref.collection('series').where('courseId', '==', courseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
/** 그 날짜에 열리는 반복 차시의 occurrenceKey */
const occurrenceOn = async (courseId, ymd, weekday) => {
  const s = (await seriesOf(courseId)).find((x) => x.weekday === weekday && x.status === 'active' && x.validFrom <= ymd && (!x.validTo || x.validTo > ymd))
  return s ? `${s.id}@${ymd}` : null
}
/** 일정 변경 미리보기(쓰지 않음): 담당이 아니면 403 또는 requiresApproval(승인 요청)이어야 함 */
const changePreview = (token, courseId, occurrenceKey) =>
  api('/api/schedule-changes', token, { action: 'preview', schoolCode: S, scope: 'date', reason: '가져오기 권한 확인(테스트)', items: [{ op: 'cancel', courseId, occurrenceKey }] })
const notOwner = (r) => r.status === 403 || (r.status === 200 && r.j.requiresApproval === true)
const stageAndPreview = async (token, rows, extra = {}) => {
  const st = await api(API, token, stageBody(rows, extra))
  const pv = await api(API, token, { action: 'preview', batchId: st.j.batchId })
  return { st, pv, batchId: st.j.batchId }
}
const linkOf = (pv, name) => (pv.j.teacherLinks || []).find((l) => l.name === name)
const LONG_AGO = () => Date.now() - 10 * 60 * 1000
const planOps = async (batchId, i) => (await sref.collection('importBatches').doc(batchId).collection('plan').doc(String(i).padStart(3, '0')).get()).get('ops') || []
const courseIdsOf = (ops) => Array.from(new Set(ops.map((o) => o.courseId)))
/**
 * 발행 도중 함수가 끊긴 상태 만들기(실제 서버에서도 재현할 수 없어 DB 상태로 흉내): 묶음 keep개까지만 반영된 것처럼
 * 나머지 묶음의 쓰기를 계획 전 값(restore, 새로 만든 문서는 삭제)으로 되돌리고, 배치를 'committing'·임대 만료로
 */
const simulateStall = async (batchId, keep) => {
  const bref = sref.collection('importBatches').doc(batchId)
  const total = (await bref.get()).get('planChunkCount')
  for (let i = keep; i < total; i++) {
    const wb = db.batch()
    for (const o of await planOps(batchId, i)) {
      const ref = sref.collection(o.target === 'course' ? 'courses' : 'series').doc(o.id)
      if (o.restore) wb.set(ref, o.restore, { merge: true })
      else wb.delete(ref)
    }
    await wb.commit()
  }
  await bref.update({ status: 'committing', progress: keep, leaseAt: LONG_AGO(), attemptId: 'killed-attempt', commitRevision: FieldValue.delete(), committedAt: FieldValue.delete() })
  return total
}
/** 큰 파일: 수업 n개(한 학급·한 교사·월/화 1교시) — 쓰기가 여러 묶음(399개 단위)으로 나뉨 */
const bigRows = (n, room) =>
  Array.from({ length: n }, (_, i) =>
    [1, 2].map((wd) => ({
      sourceKind: 'class',
      sheet: `학급시간표#${1 + (i % 6)}학년 ${1 + Math.floor(i / 6)}반`,
      row: 3 + wd,
      col: 2,
      weekday: wd,
      period: 1,
      subject: `과목${i}`,
      teacher: `교사${String(i).padStart(3, '0')}`,
      classLabel: `${1 + (i % 6)}-${1 + Math.floor(i / 6)}`,
      room,
    }))
  ).flat()

let failed = 1
try {
  await wipe()
  await createUsers([
    { uid: KIM, email: 'kim.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '김민수', masterName: '김민수' } },
    { uid: LEE, email: 'lee.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '이영희', masterName: '이영희' } },
    { uid: CHOI, email: 'choi.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '최유나', masterName: '최유나' } },
    { uid: HR4, email: 'hr4.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '박담임', classId: 'S1_3_4', grade: 3, classNm: 4 } },
    { uid: EVIL, email: 'evil.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '나교사', masterName: '나교사' } },
    // 다른 학교의 같은 이름 교사 — S1 수업의 후보가 되면 안 됨
    { uid: S2KIM, email: 's2kim.im1@test.local', doc: { role: 'teacher', schoolCode: 'S2', name: '김민수', masterName: '김민수' } },
    { uid: STA, email: 'sta.im1@test.local', doc: { role: 'student', schoolCode: S, classId: 'S1_3_4', status: 'approved', name: '가상학생A', grade: 3, classNm: 4, studentId: 7 } },
  ])
  await db.doc('classes/S1_3_4').set({ classId: 'S1_3_4', schoolCode: S, grade: 3, classNm: 4, teacherId: HR4, teacherName: '박담임', createdAt: Timestamp.now() })
  const kim = await clientSession('kim.im1@test.local')
  const lee = await clientSession('lee.im1@test.local')
  const choi = await clientSession('choi.im1@test.local')
  const hr4 = await clientSession('hr4.im1@test.local')
  const evil = await clientSession('evil.im1@test.local')
  const s2 = await clientSession('s2kim.im1@test.local')
  const st = await clientSession('sta.im1@test.local')

  // ── 권한(T39) ──
  {
    const r = await api(API, null, stageBody(THREE.rows))
    check('T39', '토큰 없이 가져오기 → 401', r.status === 401 && r.j.code === 'unauthenticated', `${r.status} ${r.j.code}`)
    const s = await api(API, st.token, stageBody(THREE.rows))
    check('T39', '학생이 시간표 가져오기 → 403', s.status === 403 && s.j.code === 'forbidden', `${s.status} ${s.j.code}`)
    const o = await api(API, s2.token, stageBody(THREE.rows))
    check('T39', '다른 학교 교사가 S1으로 올리기 → 403 school-mismatch', o.status === 403 && o.j.code === 'school-mismatch', `${o.status} ${o.j.code}`)
    const bad = await api(API, kim.token, { ...stageBody(THREE.rows), rows: 'x' })
    check('T35', '형식이 틀린 행 → 400 invalid-rows(빈 결과로 위장하지 않음)', bad.status === 400 && bad.j.code === 'invalid-rows', `${bad.status} ${bad.j.code}`)
    const many = await api(API, kim.token, { ...stageBody(THREE.rows), rows: Array.from({ length: 5001 }, () => THREE.rows[0]) })
    check('T31', '5000행 초과 → 400 too-many-rows', many.status === 400 && many.j.code === 'too-many-rows', `${many.status} ${many.j.code}`)
    const unknown = await api(API, kim.token, { action: 'nope' })
    check('T35', '알 수 없는 action → 400 bad-action', unknown.status === 400 && unknown.j.code === 'bad-action', `${unknown.status}`)
  }

  // ── T29 세 자료 통합 ──
  const rev0 = await revisionNow()
  const st1 = await api(API, kim.token, stageBody(THREE.rows))
  check('T29', 'stage → batchId·rowCount', st1.status === 200 && st1.j.rowCount === THREE.rows.length && st1.j.duplicateOf === null, `${st1.status} ${JSON.stringify(st1.j).slice(0, 160)}`)
  const b1 = st1.j.batchId
  {
    const staged = (await sref.collection('importBatches').doc(b1).get()).data() || {}
    check('T29', '임시 적재만 하고 운영 시간표는 그대로(staged, courses 없음)', staged.status === 'staged' && (await sref.collection('courses').get()).empty, staged.status)
    const other = await api(API, s2.token, { action: 'preview', batchId: b1 })
    check('T39', '다른 학교 교사는 S1 배치를 찾을 수 없음 → 404', other.status === 404 && other.j.code === 'not-found', `${other.status} ${other.j.code}`)
  }
  const pv1 = await api(API, kim.token, { action: 'preview', batchId: b1 })
  {
    const s = pv1.j.stats || {}
    check('T29', '미리보기: 차시 9개·중복 14행 합침·신규 수업 5개·오류/검토 0', pv1.status === 200 && s.lessons === 9 && s.duplicatesMerged === THREE.rows.length - 9 && s.newCourses === 5 && s.errors === 0 && s.review === 0, JSON.stringify(s))
    const by = Object.fromEntries((pv1.j.courses || []).map((c) => [c.importKey, c]))
    const music = by[K_MUSIC]
    check('T29', '같은 음악 차시가 학급·교사·특별실 자료에 있어도 차시 1개, 출처 3개', music && music.series.length === 1 && music.sources.length === 3, JSON.stringify(music?.sources))
    check('T32', '분반 수업(영어 A)은 공통 수업도 후보도 아님', same(by[K_ENGA]?.commonForHomerooms, []) && same(by[K_ENGA]?.commonCandidates, []), JSON.stringify(by[K_ENGA]))
    check(
      'T32',
      '분반 없는 한 학급 수업(3-4 국어): commonForHomerooms는 비어 있고 3-4는 공통 수업 후보(commonCandidates)로만',
      same(by[K_KOR34]?.commonForHomerooms, []) && same(by[K_KOR34]?.commonCandidates, ['S1_3_4']),
      `${JSON.stringify(by[K_KOR34]?.commonForHomerooms)} / ${JSON.stringify(by[K_KOR34]?.commonCandidates)}`
    )
    check(
      'T33',
      '교사 계정은 연결 후보로만: 3-4 국어 teacherUids 비어 있음, 후보는 같은 학교 masterName 일치 계정(다른 학교 동명이인 제외)',
      same(by[K_KOR34]?.teacherUids, []) && same(by[K_KOR34]?.candidateTeacherUids, [KIM]),
      `${JSON.stringify(by[K_KOR34]?.teacherUids)} / ${JSON.stringify(by[K_KOR34]?.candidateTeacherUids)}`
    )
    const kl = linkOf(pv1, '김민수')
    const c0 = kl?.candidates?.[0]
    check(
      'T33',
      "teacherLinks: 엑셀 이름 → 후보 계정의 표시 이름·가린 로그인 이메일('ki***@test.local')",
      kl?.reason === 'candidate' && kl.candidates.length === 1 && c0?.uid === KIM && c0?.name === '김민수' && c0?.emailMasked === 'ki***@test.local' && c0?.linkedCourseCount === 0 && kl.courseCount === 2,
      JSON.stringify(kl)
    )
    const js = JSON.stringify(pv1.j)
    check('T46', '미리보기에 학생 정보·전체 이메일·다른 학교 교사 없음', !js.includes(STA) && !js.includes('sta.im1') && !js.includes('kim.im1@') && !js.includes(S2KIM), '')
    check('T31', '후보 계정도 없는 교사(정하늘)는 이름만 — unlinkedTeachers 1, 연결 후보 이름 3', s.unlinkedTeachers === 1 && s.teacherLinkCandidates === 3 && linkOf(pv1, '정하늘')?.reason === 'no-account', JSON.stringify(s))
    check('T29', '미리보기가 현재 scheduleRevision을 돌려줌', pv1.j.revision === rev0, `${pv1.j.revision} vs ${rev0}`)
  }

  // ── 커밋(확인 목록 없음) ──
  {
    const stale = await api(API, kim.token, { action: 'commit', batchId: b1, expectedRevision: pv1.j.revision + 5 })
    check('T27', '오래된 expectedRevision으로 확정 → 409 stale-revision(덮어쓰지 않음)', stale.status === 409 && stale.j.code === 'stale-revision' && stale.j.revision === rev0, `${stale.status} ${stale.j.code}`)
    check('T27', 'stale 요청 뒤에도 수업 문서가 생기지 않음', (await sref.collection('courses').get()).empty)
    const badConfirm = await api(API, kim.token, { action: 'commit', batchId: b1, expectedRevision: pv1.j.revision, confirmTeacherUids: 'im1-t-lee' })
    check('T35', '확인 목록 형식 오류 → 400 invalid-confirm', badConfirm.status === 400 && badConfirm.j.code === 'invalid-confirm', `${badConfirm.status} ${badConfirm.j.code}`)
  }
  const c1 = await api(API, kim.token, { action: 'commit', batchId: b1, expectedRevision: pv1.j.revision })
  check('T29', '확정 → 수업 5개 생성', c1.status === 200 && c1.j.created?.length === 5 && c1.j.revision === rev0 + 1 && same(c1.j.confirmedTeacherUids, []), `${c1.status} ${JSON.stringify(c1.j).slice(0, 200)}`)
  {
    const courses = await sref.collection('courses').get()
    const series = await sref.collection('series').get()
    check('T29', 'Firestore: 수업 5·차시 9, 수업마다 importKey·source import·importBatchId', courses.size === 5 && series.size === 9 && courses.docs.every((d) => d.get('source') === 'import' && d.get('importKey') && d.get('importBatchId') === b1), `${courses.size}/${series.size}`)
    check('T29', 'scheduleRevision +1 한 번', (await revisionNow()) === rev0 + 1)
    const docs = courses.docs.map((d) => d.data())
    check('T33', '확인 없이 발행: 모든 수업 teacherUids·importLinkedUids 비어 있음(이름만)', docs.every((d) => same(d.teacherUids, []) && same(d.importLinkedUids, []) && d.teacherNames.length > 0), JSON.stringify(docs.map((d) => d.teacherUids)))
    check('T32', '가져오기는 commonForHomerooms를 쓰지 않음: 모든 수업 [] (후보는 importCommon)', docs.every((d) => same(d.commonForHomerooms, [])), JSON.stringify(docs.map((d) => d.commonForHomerooms)))
    const kor = await courseByKey(K_KOR34)
    check('T32', '3-4 국어: importCommon ["S1_3_4"](공통 수업 후보만)', same(kor?.importCommon, ['S1_3_4']), JSON.stringify(kor?.importCommon))
    check('T40', '가져오기로 만든 수업의 managerUids = 발행 교사', docs.every((d) => same(d.managerUids, [KIM])), JSON.stringify(docs.map((d) => d.managerUids)))
    const engA = await courseByKey(K_ENGA)
    check('T32', '분반 수업 문서: commonForHomerooms [] · catalogVisible false', engA && engA.commonForHomerooms.length === 0 && engA.catalogVisible === false, JSON.stringify(engA?.commonForHomerooms))
    check('T32', '수강 명단 없이 수강(enrollments)을 만들지 않음', (await sref.collection('enrollments').get()).empty)
    const audit = await sref.collection('audit').where('action', '==', 'timetable-import.commit').get()
    const a0 = audit.docs[0]?.data() || {}
    check('T46', '감사 로그: 배치·수·버전만(행·토큰 없음)', audit.size === 1 && !JSON.stringify(a0).includes('rows') && !JSON.stringify(a0).includes('token'), JSON.stringify(a0.meta || {}).slice(0, 160))
    const again = await api(API, kim.token, { action: 'commit', batchId: b1, expectedRevision: pv1.j.revision })
    check('T28', '같은 배치 다시 확정 → 같은 결과, 버전 그대로', again.status === 200 && again.j.alreadyCommitted === true && (await revisionNow()) === rev0 + 1, `${again.status}`)
  }

  // ── T32 학생 시간표: 발행만으로는 없음 → 담임 확인 후 공통 수업만 ──
  const kor34 = await courseByKey(K_KOR34)
  const engA = await courseByKey(K_ENGA)
  const music = await courseByKey(K_MUSIC)
  const engB = await courseByKey(K_ENGB)
  {
    const me = await api(ME, st.token, null, 'GET')
    const ids = (me.j.courses || []).map((c) => c.courseId)
    check('T32', '발행 직후 3-4 학생 /api/timetable/me: 가져온 수업 없음(공통 수업 후보는 연결되지 않음)', me.status === 200 && ids.length === 0, `${me.status} ${me.j.code || ''} ${JSON.stringify(ids)}`)

    const notHr = await api('/api/courses', kim.token, { action: 'setCommon', courseId: kor34.id, homeroomId: 'S1_3_4', enabled: true })
    check('T40', '담임이 아닌 교사(발행 교사)가 공통 수업 지정 → 403 not-homeroom-teacher', notHr.status === 403 && notHr.j.code === 'not-homeroom-teacher', `${notHr.status} ${notHr.j.code}`)
    const revA = await revisionNow()
    const sc = await api('/api/courses', hr4.token, { action: 'setCommon', courseId: kor34.id, homeroomId: 'S1_3_4', enabled: true })
    check('T03', '3-4 담임이 공통 수업 후보를 확인(setCommon) → 200, 버전 +1', sc.status === 200 && sc.j.enabled === true && (await revisionNow()) === revA + 1, `${sc.status} ${JSON.stringify(sc.j).slice(0, 160)}`)
    const me2 = await api(ME, st.token, null, 'GET')
    const ids2 = (me2.j.courses || []).map((c) => c.courseId)
    const ser2 = (me2.j.series || []).map((s) => s.courseId)
    check('T03', '담임 확인 뒤 3-4 학생 시간표에 3-4 국어만(영어 A·음악 등은 없음)', me2.status === 200 && same(ids2, [kor34.id]) && ser2.length > 0 && ser2.every((c) => c === kor34.id), `${me2.status} ${JSON.stringify(ids2)}`)
  }

  // ── 담당 권한: 확인 없이 발행하면 후보 교사는 담당이 아님 ──
  const occA = await occurrenceOn(engA.id, TUE1, 2)
  const occM = await occurrenceOn(music.id, THU1, 4)
  {
    const p = await changePreview(lee.token, engA.id, occA)
    check('T40', '확인 없이 발행: 후보 교사(이영희)의 영어 A 변경 → 담당 아님(403 또는 승인 요청)', notOwner(p), `${p.status} requiresApproval=${p.j.requiresApproval} ${p.j.code || ''}`)
    const l = await api('/api/schedule-changes', lee.token, { action: 'list', courseId: engA.id })
    check('T40', '확인 없이 발행: 이영희는 영어 A 변경 기록 조회 불가 → 403', l.status === 403, `${l.status} ${l.j.code}`)
    const g = await api('/api/courses', lee.token, { action: 'get', courseId: engA.id })
    check('T40', '확인 없이 발행: 이영희는 영어 A 수업 관리(get) 불가 → 403', g.status === 403, `${g.status} ${g.j.code}`)
    const mgr = await changePreview(kim.token, engA.id, occA)
    check('T40', '발행 교사(관리 교사)는 승인 없이 변경 가능', mgr.status === 200 && mgr.j.requiresApproval === false, `${mgr.status} ${mgr.j.requiresApproval} ${mgr.j.code || ''}`)
  }

  // ── T30 같은 파일 재업로드 / 순서 바꿈 ──
  {
    const st2 = await api(API, kim.token, stageBody(THREE.rows))
    check('T30', '같은 파일 재업로드 → duplicateOf로 식별', st2.status === 200 && st2.j.duplicateOf === b1, `${st2.j.duplicateOf}`)
    const pv2 = await api(API, kim.token, { action: 'preview', batchId: st2.j.batchId })
    check('T30', '같은 파일 미리보기 → 신규·갱신 0, 동일 5', pv2.j.stats?.newCourses === 0 && pv2.j.stats?.updatedCourses === 0 && pv2.j.stats?.unchanged === 5, JSON.stringify(pv2.j.stats))
    const k2 = (pv2.j.courses || []).find((c) => c.importKey === K_KOR34)
    check('T32', '미리보기: 담임이 확인한 값(commonForHomerooms)과 후보를 함께 보여 줌', same(k2?.commonForHomerooms, ['S1_3_4']) && same(k2?.commonCandidates, ['S1_3_4']), JSON.stringify(k2))
    const revB = await revisionNow()
    const c2 = await api(API, kim.token, { action: 'commit', batchId: st2.j.batchId, expectedRevision: pv2.j.revision })
    check('T30', '같은 파일 확정 → 쓰기 없음·버전 그대로', c2.status === 200 && c2.j.created.length === 0 && c2.j.updated.length === 0 && (await revisionNow()) === revB, JSON.stringify(c2.j).slice(0, 160))
    check('T30', '중복 수업·차시 없음(수업 5·차시 9 유지)', (await sref.collection('courses').get()).size === 5 && (await sref.collection('series').get()).size === 9)
    check('T32', '재업로드가 담임의 공통 수업 확인을 덮어쓰지 않음', same((await courseByKey(K_KOR34)).commonForHomerooms, ['S1_3_4']))

    const rows3 = shuffled(THREE.rows, 7)
    const st3 = await api(API, kim.token, stageBody(rows3, { fileName: '순서바꿈.xlsx' }))
    const pv3 = await api(API, kim.token, { action: 'preview', batchId: st3.j.batchId })
    check('T30', '행 순서를 바꾼 파일 → 모두 동일', pv3.j.stats?.unchanged === 5 && pv3.j.stats?.newCourses === 0, JSON.stringify(pv3.j.stats))
    const cancel = await api(API, kim.token, { action: 'cancel', batchId: st3.j.batchId })
    check('T30', 'staged 배치 취소', cancel.status === 200 && cancel.j.status === 'cancelled', `${cancel.status}`)
    const afterCancel = await api(API, kim.token, { action: 'commit', batchId: st3.j.batchId, expectedRevision: pv3.j.revision })
    check('T30', '취소된 배치 확정 → 409 bad-status', afterCancel.status === 409 && afterCancel.j.code === 'bad-status', `${afterCancel.status} ${afterCancel.j.code}`)
    const cancelCommitted = await api(API, kim.token, { action: 'cancel', batchId: b1 })
    check('T30', '발행된 배치 취소 → 409(원복을 써야 함)', cancelCommitted.status === 409 && cancelCommitted.j.code === 'bad-status', `${cancelCommitted.status}`)
  }

  // ── 발행 교사가 확인한 후보만 연결 ──
  {
    const { pv, batchId } = await stageAndPreview(kim.token, THREE.rows, { fileName: '연결확인.xlsx' })
    const ll = linkOf(pv, '이영희')
    check('T33', '미리보기: 이영희 후보(le***@test.local), 아직 연결 안 됨', ll?.candidates?.[0]?.uid === LEE && ll.candidates[0].emailMasked === 'le***@test.local' && ll.candidates[0].linkedCourseCount === 0, JSON.stringify(ll))
    const revC = await revisionNow()
    const c = await api(API, kim.token, { action: 'commit', batchId, expectedRevision: pv.j.revision, confirmTeacherUids: [LEE, S2KIM, STA, 'not-a-teacher'] })
    check(
      'T39',
      '확인 목록 중 서버가 다시 계산한 후보(이영희)만 연결, 다른 학교 교사·학생·임의 uid는 무시',
      c.status === 200 && same(c.j.confirmedTeacherUids, [LEE]) && c.j.ignoredTeacherCount === 3 && same(c.j.updated, [engA.id]) && (await revisionNow()) === revC + 1,
      `${c.status} ${JSON.stringify(c.j).slice(0, 220)}`
    )
    const a = await courseByKey(K_ENGA)
    check('T33', '영어 A: teacherUids·importLinkedUids = [이영희], managerUids는 그대로', same(a.teacherUids, [LEE]) && same(a.importLinkedUids, [LEE]) && same(a.managerUids, [KIM]), JSON.stringify([a.teacherUids, a.managerUids]))
    const others = await Promise.all([K_KOR34, K_KOR35, K_MUSIC, K_ENGB].map(courseByKey))
    check('T33', '이영희는 후보가 아닌 다른 수업에는 연결되지 않음', others.every((d) => !d.teacherUids.includes(LEE) && !d.teacherUids.includes(S2KIM) && !d.teacherUids.includes(STA)), JSON.stringify(others.map((d) => d.teacherUids)))
    const bdoc = JSON.stringify((await sref.collection('importBatches').doc(batchId).get()).data() || {})
    check('T46', '배치 문서에 무시한 uid(학생 uid 등)를 저장하지 않음(개수만)', !bdoc.includes(STA) && !bdoc.includes('not-a-teacher'), '')
    const p = await changePreview(lee.token, engA.id, occA)
    check('T40', '확인 후 발행: 이영희가 영어 A 담당 → 승인 없이 변경 가능', p.status === 200 && p.j.requiresApproval === false, `${p.status} ${p.j.requiresApproval}`)
    const l = await api('/api/schedule-changes', lee.token, { action: 'list', courseId: engA.id })
    check('T40', '확인 후 발행: 이영희가 영어 A 변경 기록 조회 → 200', l.status === 200, `${l.status}`)
    const { pv: pvAgain } = await stageAndPreview(kim.token, THREE.rows, { fileName: '연결확인-다시.xlsx' })
    const la = linkOf(pvAgain, '이영희')
    check('T30', '다음 미리보기: 이전에 확인된 연결은 유지(동일 5, 이영희 이미 연결)', pvAgain.j.stats?.unchanged === 5 && la?.linked === true && la.candidates[0].linkedCourseCount === 1, JSON.stringify(la))
  }

  // ── 다른 교사 이름을 masterName으로 바꾼 교사 ──
  {
    const { doc, updateDoc } = req('firebase/firestore')
    let wrote = true
    try {
      await updateDoc(doc(evil.d, 'users', EVIL), { masterName: '최유나' })
    } catch {
      wrote = false
    }
    check('T39', '(전제) 교사는 자기 masterName을 클라이언트에서 바꿀 수 있음', wrote)
    const { pv, batchId } = await stageAndPreview(kim.token, THREE.rows, { fileName: 'masterName.xlsx' })
    const cl = linkOf(pv, '최유나')
    const uids = (cl?.candidates || []).map((x) => x.uid).sort()
    check(
      'T33',
      '같은 masterName 계정 둘 → 둘 다 후보(ambiguous)로 이름·가린 이메일과 함께 보여 줌',
      cl?.reason === 'ambiguous' && same(uids, [CHOI, EVIL].sort()) && cl.candidates.every((x) => /^(ch|ev)\*\*\*@test\.local$/.test(x.emailMasked || '')),
      JSON.stringify(cl)
    )
    const revD = await revisionNow()
    const c = await api(API, kim.token, { action: 'commit', batchId, expectedRevision: pv.j.revision })
    const m = await courseByKey(K_MUSIC)
    check('T39', '확인 없이 발행: masterName을 바꾼 교사가 음악 수업 권한을 얻지 못함(음악 teacherUids 그대로 [])', c.status === 200 && same(m.teacherUids, []) && (await revisionNow()) === revD, `${c.status} ${JSON.stringify(m.teacherUids)}`)
    const p = await changePreview(evil.token, music.id, occM)
    check('T40', 'masterName을 바꾼 교사의 음악 변경 → 담당 아님(403 또는 승인 요청)', notOwner(p), `${p.status} requiresApproval=${p.j.requiresApproval}`)
    const l = await api('/api/schedule-changes', evil.token, { action: 'list', courseId: music.id })
    check('T40', 'masterName을 바꾼 교사의 음악 변경 기록 조회 → 403', l.status === 403, `${l.status}`)

    // 실제 담당 교사만 체크해 확인 → 그 교사만 연결
    const r2 = await stageAndPreview(kim.token, THREE.rows, { fileName: 'masterName-확인.xlsx' })
    const c2 = await api(API, kim.token, { action: 'commit', batchId: r2.batchId, expectedRevision: r2.pv.j.revision, confirmTeacherUids: [CHOI] })
    const m2 = await courseByKey(K_MUSIC)
    check('T33', '동명이인 후보 중 확인한 계정(최유나)만 연결, masterName을 바꾼 교사는 제외', c2.status === 200 && same(m2.teacherUids, [CHOI]) && same(c2.j.confirmedTeacherUids, [CHOI]), `${c2.status} ${JSON.stringify(m2.teacherUids)}`)
    const pc = await changePreview(choi.token, music.id, occM)
    check('T40', '확인된 최유나는 음악 담당 → 승인 없이 변경 가능', pc.status === 200 && pc.j.requiresApproval === false, `${pc.status} ${pc.j.requiresApproval}`)
    const pe = await changePreview(evil.token, music.id, occM)
    check('T40', '여전히 masterName을 바꾼 교사는 음악 담당 아님', notOwner(pe), `${pe.status} ${pe.j.requiresApproval}`)

    // 가입하지 않은 교사(정하늘) 이름을 차지 → 유일한 후보여도 확인 없이는 권한 없음
    await updateDoc(doc(evil.d, 'users', EVIL), { masterName: '정하늘' })
    const r3 = await stageAndPreview(kim.token, THREE.rows, { fileName: 'masterName-정하늘.xlsx' })
    const jl = linkOf(r3.pv, '정하늘')
    check('T33', "계정 없는 교사 이름을 차지한 교사는 '후보'로만 보임", jl?.reason === 'candidate' && jl.candidates[0]?.uid === EVIL && jl.candidates[0]?.linkedCourseCount === 0, JSON.stringify(jl))
    const c3 = await api(API, kim.token, { action: 'commit', batchId: r3.batchId, expectedRevision: r3.pv.j.revision })
    const b = await courseByKey(K_ENGB)
    check('T39', '확인 없이 발행: 영어 B teacherUids 그대로 [] — 이름만으로 권한 없음', c3.status === 200 && same(b.teacherUids, []), `${c3.status} ${JSON.stringify(b.teacherUids)}`)
    const g = await api('/api/courses', evil.token, { action: 'get', courseId: engB.id })
    check('T40', 'masterName을 바꾼 교사의 영어 B 수업 관리(get) → 403', g.status === 403, `${g.status} ${g.j.code}`)
    note('T39', '남은 위험: 같은 학교 교사는 누구나 가져오기를 발행할 수 있어, 자기 계정이 후보인 수업에 자기를 확인해 연결할 수 있음(감사 로그에 confirmedTeacherUids·actorUid 기록). 발행 권한을 학교 관리자로 좁히는 것은 별도 결정 필요')
  }

  // ── T30 수정본(적용일 X2) ──
  const rows4 = revisedRows()
  const st4 = await api(API, kim.token, stageBody(rows4, { validFrom: X2, fileName: '수정본.xlsx' }))
  const b4 = st4.j.batchId
  const pv4 = await api(API, kim.token, { action: 'preview', batchId: b4 })
  check('T30', '수정본 미리보기 → 갱신 2(음악 장소·3-5 국어 교시), 동일 3', pv4.j.stats?.updatedCourses === 2 && pv4.j.stats?.unchanged === 3 && pv4.j.stats?.newCourses === 0, JSON.stringify(pv4.j.stats))
  const revE = await revisionNow()
  const c4 = await api(API, kim.token, { action: 'commit', batchId: b4, expectedRevision: pv4.j.revision })
  check('T30', '수정본 확정 → updated 2, 버전 +1', c4.status === 200 && c4.j.updated?.length === 2 && (await revisionNow()) === revE + 1, `${c4.status} ${JSON.stringify(c4.j).slice(0, 160)}`)
  {
    const ss = await seriesOf(music.id)
    const old = ss.find((s) => s.validFrom === X1)
    const neu = ss.find((s) => s.validFrom === X2)
    check('T21', '기본 시간표 변경: 기존 차시 validTo=적용일(과거 보존), 새 차시 validFrom=적용일', old?.validTo === X2 && old?.roomName === '음악실' && neu?.validTo === null && neu?.roomName === '음악실2', JSON.stringify(ss.map((s) => [s.validFrom, s.validTo, s.roomName, s.status])))
    const m = await courseByKey(K_MUSIC)
    check('T33', '수정본(확인 목록 없음)도 이전에 확인된 담당 교사 연결(최유나)을 유지', same(m.teacherUids, [CHOI]) && same(m.managerUids, [KIM]), JSON.stringify([m.teacherUids, m.managerUids]))
    check('T32', '수정본도 담임의 공통 수업 확인을 덮어쓰지 않음', same((await courseByKey(K_KOR34)).commonForHomerooms, ['S1_3_4']))
  }

  // ── T31 원본 오류 → 발행 거부 ──
  {
    const revF = await revisionNow()
    const st5 = await api(API, kim.token, stageBody(AMB.rows, { fileName: '오류.xlsx' }))
    const pv5 = await api(API, kim.token, { action: 'preview', batchId: st5.j.batchId })
    const codes = new Set((pv5.j.issues || []).map((i) => i.code))
    const period = (pv5.j.issues || []).find((i) => i.code === 'bad-period')
    check('T31', '잘못된 교시·요일·시각·교사 충돌 → error, 행 번호·고칠 방법', pv5.j.stats?.errors >= 4 && period?.rows?.[0]?.row === 14 && !!period?.fix, JSON.stringify(period))
    check('T31', '미연결 교사·중복 분반·모호한 매칭·이동수업 후보 검출', ['teacher-unlinked', 'duplicate-section', 'ambiguous-match', 'class-slot-multiple', 'teacher-missing'].every((c) => codes.has(c)), Array.from(codes).join(','))
    const c5 = await api(API, kim.token, { action: 'commit', batchId: st5.j.batchId, expectedRevision: pv5.j.revision, acceptReview: true })
    check('T31', '오류가 있으면 확정 거부 → 422 has-errors(완전한 시간표처럼 발행하지 않음)', c5.status === 422 && c5.j.code === 'has-errors', `${c5.status} ${c5.j.code}`)
    check('T31', '거부 후 버전·수업 수 그대로', (await revisionNow()) === revF && (await sref.collection('courses').get()).size === 5)
  }

  // ── 검토 항목: acceptReview 없으면 409, 있으면 해당 수업 제외하고 발행 ──
  {
    const rows6 = rows4.concat([{ sourceKind: 'class', sheet: '학급시간표#3학년 6반', row: 3, col: 2, weekday: 1, period: 1, subject: '체육', classLabel: '3-6' }])
    const st6 = await api(API, kim.token, stageBody(rows6, { validFrom: X2, fileName: '검토.xlsx' }))
    const pv6 = await api(API, kim.token, { action: 'preview', batchId: st6.j.batchId })
    check('T31', '교사 없는 수업 → review(교사 미확인)', pv6.j.stats?.review >= 1 && pv6.j.stats?.errors === 0, JSON.stringify(pv6.j.stats))
    const nr = await api(API, kim.token, { action: 'commit', batchId: st6.j.batchId, expectedRevision: pv6.j.revision })
    check('T31', '검토 항목이 있는데 acceptReview 없음 → 409 needs-review', nr.status === 409 && nr.j.code === 'needs-review', `${nr.status} ${nr.j.code}`)
    const ok = await api(API, kim.token, { action: 'commit', batchId: st6.j.batchId, expectedRevision: pv6.j.revision, acceptReview: true })
    const ex = (ok.j.excluded || []).map((e) => e.importKey)
    check('T31', 'acceptReview → 검토 수업은 발행에서 제외하고 excluded로 남김', ok.status === 200 && ex.includes('hr|3-6|체육|') && !(await courseByKey('hr|3-6|체육|')), JSON.stringify(ok.j.excluded))
    const bdoc = (await sref.collection('importBatches').doc(st6.j.batchId).get()).data() || {}
    check('T31', '배치 문서에도 excluded 기록', (bdoc.excluded || []).some((e) => e.importKey === 'hr|3-6|체육|'))
  }

  // ── T23 원복 ──
  {
    const revA = await revisionNow()
    const stale = await api(API, kim.token, { action: 'rollback', batchId: b4, expectedRevision: revA - 1 })
    check('T27', '오래된 버전으로 원복 → 409 stale-revision', stale.status === 409 && stale.j.code === 'stale-revision', `${stale.status}`)
    const rb = await api(API, kim.token, { action: 'rollback', batchId: b4, expectedRevision: revA })
    check('T23', '수정본 원복 → 그 배치가 바꾼 수업 2개 복원, 버전 +1', rb.status === 200 && rb.j.restored?.length === 2 && rb.j.skipped?.length === 0 && (await revisionNow()) === revA + 1, `${rb.status} ${JSON.stringify(rb.j).slice(0, 200)}`)
    const ss = await seriesOf(music.id)
    const old = ss.find((s) => s.validFrom === X1)
    const neu = ss.find((s) => s.validFrom === X2)
    check('T23', '원복: 이전 차시 validTo 복원, 그 배치가 만든 차시는 종료(삭제 아님)', old?.validTo === null && old?.status === 'active' && neu?.status === 'retired', JSON.stringify(ss.map((s) => [s.validFrom, s.validTo, s.status])))
    const m = await courseByKey(K_MUSIC)
    check('T23', '원복은 그 배치 이전 값으로 — 확인된 담당 교사(최유나)·담임 공통 수업 확인은 그대로', same(m.teacherUids, [CHOI]) && same((await courseByKey(K_KOR34)).commonForHomerooms, ['S1_3_4']), JSON.stringify(m.teacherUids))
    const again = await api(API, kim.token, { action: 'rollback', batchId: b4, expectedRevision: revA + 1 })
    check('T28', '같은 원복 재요청 → 같은 결과(alreadyRolledBack)', again.status === 200 && again.j.alreadyRolledBack === true && (await revisionNow()) === revA + 1)

    // 첫 배치 원복: 이후 담임 확인(3-4 국어)·연결 확인 배치(영어 A·음악)로 바뀐 수업은 건너뜀
    await sref.collection('courses').doc(kor34.id).set({ title: '국어(담임 수정)', revision: 999 }, { merge: true })
    const revB = await revisionNow()
    const rb1 = await api(API, kim.token, { action: 'rollback', batchId: b1, expectedRevision: revB })
    const skippedIds = (rb1.j.skipped || []).map((s) => s.courseId).sort()
    const restoredIds = (rb1.j.restored || []).slice().sort()
    const k35 = await courseByKey(K_KOR35)
    check(
      'T23',
      '첫 배치 원복: 이후 바뀐 수업(3-4 국어·영어 A·음악)은 skipped, 나머지(3-5 국어·영어 B) 원복',
      rb1.status === 200 && same(skippedIds, [kor34.id, engA.id, music.id].sort()) && same(restoredIds, [k35.id, engB.id].sort()),
      JSON.stringify(rb1.j).slice(0, 300)
    )
    const korSeries = await seriesOf(kor34.id)
    check('T23', '건너뛴 수업의 차시는 그대로 active', korSeries.length === 2 && korSeries.every((s) => s.status === 'active'), JSON.stringify(korSeries.map((s) => s.status)))
    const eb = await courseByKey(K_ENGB)
    const ebSeries = await seriesOf(eb.id)
    check('T23', '원복된 수업: 문서는 남고(ended) 차시는 retired — 삭제하지 않음', eb.status === 'ended' && ebSeries.length === 2 && ebSeries.every((s) => s.status === 'retired'), `${eb.status} ${JSON.stringify(ebSeries.map((s) => s.status))}`)
  }

  // ── [검토 결함] 교사 연결 확인은 (엑셀 이름, 계정) 쌍 — 미리보기 뒤 masterName을 바꿔도 다른 이름의 수업에 연결되지 않음 ──
  const T27 = { termId: '2027-1', validFrom: '20270301' }
  const PAIR_ROWS = [
    { sourceKind: 'class', sheet: '학급시간표#1학년 1반', row: 3, col: 2, weekday: 1, period: 1, subject: '국어', teacher: '김철수', classLabel: '1-1' },
    { sourceKind: 'class', sheet: '학급시간표#1학년 1반', row: 4, col: 2, weekday: 1, period: 2, subject: '수학', teacher: '박영희', classLabel: '1-1' },
  ]
  const K_P1 = 'hr|1-1|국어|김철수'
  const K_P2 = 'hr|1-1|수학|박영희'
  {
    await createUsers([
      { uid: P1, email: 'p1.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '김철수', masterName: '김철수' } },
      { uid: P2, email: 'p2.im1@test.local', doc: { role: 'teacher', schoolCode: S, name: '박영희', masterName: '박영희' } },
    ])
    const p1 = await clientSession('p1.im1@test.local')
    const { doc, updateDoc } = req('firebase/firestore')
    const { pv, batchId } = await stageAndPreview(kim.token, PAIR_ROWS, { ...T27, fileName: '연결쌍.xlsx' })
    const l1 = linkOf(pv, '김철수')
    check('T33', "미리보기 teacherLinks에 엑셀 이름키(nameKey) — 연결 확인은 (nameKey, uid) 쌍으로 보냄", pv.status === 200 && l1?.nameKey === '김철수' && linkOf(pv, '박영희')?.nameKey === '박영희' && l1.candidates[0]?.uid === P1, JSON.stringify(pv.j.teacherLinks))
    await updateDoc(doc(p1.d, 'users', P1), { masterName: '박영희' })
    const stalePair = await api(API, kim.token, { action: 'commit', batchId, expectedRevision: pv.j.revision, confirmTeacherLinks: [{ nameKey: '김철수', uid: P1 }] })
    check('T39', '미리보기 뒤 확인한 교사가 masterName을 다른 엑셀 이름으로 바꿈 → 409 stale-revision(교사 후보 매핑도 비교)', stalePair.status === 409 && stalePair.j.code === 'stale-revision', `${stalePair.status} ${stalePair.j.code}`)
    const staleLegacy = await api(API, kim.token, { action: 'commit', batchId, expectedRevision: pv.j.revision, confirmTeacherUids: [P1] })
    check('T39', '이전 형식(confirmTeacherUids)으로 보내도 같은 상황 → 409', staleLegacy.status === 409 && staleLegacy.j.code === 'stale-revision', `${staleLegacy.status} ${staleLegacy.j.code}`)
    check('T39', '거부 뒤 수업 문서가 생기지 않음', !(await courseByKey(K_P1)) && !(await courseByKey(K_P2)))
    const pv2 = await api(API, kim.token, { action: 'preview', batchId })
    check('T33', "다시 미리보기: '박영희' 후보 둘(ambiguous), '김철수'는 후보 없음", linkOf(pv2, '박영희')?.reason === 'ambiguous' && linkOf(pv2, '김철수')?.reason === 'no-account', JSON.stringify(pv2.j.teacherLinks))
    const c = await api(API, kim.token, {
      action: 'commit',
      batchId,
      expectedRevision: pv2.j.revision,
      confirmTeacherLinks: [
        { nameKey: '김철수', uid: P1 },
        { nameKey: '박영희', uid: P2 },
      ],
    })
    const a1 = await courseByKey(K_P1)
    const a2 = await courseByKey(K_P2)
    check(
      'T39',
      "확정: '김철수 = P1' 확인은 무시(후보 아님), '박영희 = P2'만 박영희 수업에 — P1은 어느 수업에도 연결되지 않음",
      c.status === 200 && same(c.j.confirmedTeacherLinks, [{ nameKey: '박영희', uid: P2 }]) && same(c.j.confirmedTeacherUids, [P2]) && c.j.ignoredTeacherCount === 1 && same(a2?.teacherUids, [P2]) && same(a1?.teacherUids, []),
      `${c.status} ${JSON.stringify(c.j).slice(0, 240)} ${JSON.stringify([a1?.teacherUids, a2?.teacherUids])}`
    )
    const audit = await sref.collection('audit').where('action', '==', 'timetable-import.commit').where('target', '==', `importBatches/${batchId}`).get()
    check('T46', '감사 로그에 확인한 (엑셀 이름키, 교사 uid) 쌍', audit.size === 1 && same(audit.docs[0].get('meta.confirmedTeacherLinks'), [{ nameKey: '박영희', uid: P2 }]), JSON.stringify(audit.docs[0]?.get('meta') || {}).slice(0, 200))
    const bad = await api(API, kim.token, { action: 'commit', batchId, expectedRevision: 0, confirmTeacherLinks: [{ nameKey: '', uid: P1 }] })
    check('T35', '연결 확인 쌍 형식 오류 → 400 invalid-confirm', bad.status === 400 && bad.j.code === 'invalid-confirm', `${bad.status} ${bad.j.code}`)
    await updateDoc(doc(p1.d, 'users', P1), { masterName: '김철수' })
    await p1.close()
  }

  // ── [검토 결함] 수강 변경(학교 scheduleRevision +1)만으로는 발행이 막히지 않고, 수업이 실제로 바뀌면 409 ──
  {
    const rowsB = PAIR_ROWS.map((r) => ({ ...r, room: '1-1 교실' }))
    const { pv, batchId } = await stageAndPreview(kim.token, rowsB, { ...T27, fileName: '수강변경중.xlsx' })
    check('T27', '(전제) 장소를 넣은 수정본 미리보기: 갱신 2', pv.j.stats?.updatedCourses === 2 && pv.j.stats?.errors === 0, JSON.stringify(pv.j.stats))
    const p2c = await courseByKey(K_P2)
    const add = await api('/api/enrollments', kim.token, { action: 'add', courseId: p2c.id, uid: STA })
    const revAdd = await revisionNow()
    check('T27', '(전제) 미리보기 뒤 담당 교사가 학생을 수강 추가 → 학교 scheduleRevision +1', add.status === 200 && revAdd === pv.j.revision + 1, `${add.status} ${add.j.code || ''} ${revAdd} vs ${pv.j.revision}`)
    const c = await api(API, kim.token, { action: 'commit', batchId, expectedRevision: pv.j.revision })
    check('T27', '수강 변경만 있었으면 확정 200(수업·차시 계획이 미리보기와 같음), 학교 버전 +1', c.status === 200 && c.j.updated?.length === 2 && c.j.revision === revAdd + 1 && (await revisionNow()) === revAdd + 1, `${c.status} ${c.j.code || ''} ${JSON.stringify(c.j).slice(0, 160)}`)
    check('T27', '발행한 차시에 새 장소 반영', (await seriesOf(p2c.id)).some((x) => x.roomName === '1-1 교실' && x.status === 'active' && !x.validTo))

    const r2 = await stageAndPreview(kim.token, PAIR_ROWS.map((r) => ({ ...r, room: '1-1 특별실' })), { ...T27, fileName: '수업변경중.xlsx' })
    const upd = await api('/api/courses', kim.token, { action: 'update', courseId: p2c.id, title: '수학(담당 수정)' })
    check('T27', '(전제) 미리보기 뒤 담당 교사가 수업 이름을 고침', upd.status === 200, `${upd.status} ${upd.j.code || ''}`)
    const s2 = await api(API, kim.token, { action: 'commit', batchId: r2.batchId, expectedRevision: r2.pv.j.revision })
    check('T27', '미리보기 뒤 수업 문서가 실제로 바뀌면 409 stale-revision(덮어쓰지 않음)', s2.status === 409 && s2.j.code === 'stale-revision' && (await courseByKey(K_P2)).title === '수학(담당 수정)', `${s2.status} ${s2.j.code}`)
    const older = await api(API, kim.token, { action: 'commit', batchId: r2.batchId, expectedRevision: r2.pv.j.revision - 1 })
    check('T27', '화면의 미리보기 버전이 이 배치의 마지막 미리보기와 다르면 409 stale-revision', older.status === 409 && older.j.code === 'stale-revision', `${older.status} ${older.j.code}`)
    await api(API, kim.token, { action: 'cancel', batchId: r2.batchId })
  }

  // ── [검토 결함] 발행 도중 끊긴 배치('committing', 임대 만료): 이어서 발행(수강 변경 뒤에도)·원복, 바뀐 수업이 있으면 409 ──
  {
    const T27b = { termId: '2027-2', validFrom: '20270906' }
    const bref = (id) => sref.collection('importBatches').doc(id)
    const f1 = await stageAndPreview(kim.token, bigRows(200, '교실A'), { ...T27b, fileName: '큰파일-1.xlsx' })
    check('T28', '(전제) 큰 파일 미리보기: 새 수업 200, 오류·검토 0', f1.pv.j.stats?.newCourses === 200 && f1.pv.j.stats?.errors === 0 && f1.pv.j.stats?.review === 0, JSON.stringify(f1.pv.j.stats))
    const c1 = await api(API, kim.token, { action: 'commit', batchId: f1.batchId, expectedRevision: f1.pv.j.revision })
    check('T28', '(전제) 큰 파일 확정: 수업 200, 계획 묶음 2개', c1.status === 200 && c1.j.created?.length === 200 && (await bref(f1.batchId).get()).get('planChunkCount') === 2, `${c1.status} ${c1.j.code || ''}`)

    // 마무리 트랜잭션 직전에 끊김(모든 묶음 반영, 'committing' 그대로) → 이어서 하면 마무리만
    const total1 = await simulateStall(f1.batchId, 2)
    const revF = await revisionNow()
    const fin = await api(API, kim.token, { action: 'commit', batchId: f1.batchId, expectedRevision: revF })
    check('T28', "모든 묶음 반영 뒤 마무리 전에 끊긴 'committing' → 이어서 하기로 마무리(committed, 버전 +1)", total1 === 2 && fin.status === 200 && fin.j.status === 'committed' && (await revisionNow()) === revF + 1, `${fin.status} ${fin.j.code || ''}`)

    // 수정본(장소 변경): 수업마다 쓰기 5개 → 3묶음. 첫 묶음만 반영된 채 끊김
    const f2 = await stageAndPreview(kim.token, bigRows(200, '교실B'), { ...T27b, validFrom: '20271004', fileName: '큰파일-2.xlsx' })
    const c2 = await api(API, kim.token, { action: 'commit', batchId: f2.batchId, expectedRevision: f2.pv.j.revision })
    check('T28', '(전제) 수정본 확정: 갱신 200, 계획 묶음 3개', c2.status === 200 && c2.j.updated?.length === 200 && (await bref(f2.batchId).get()).get('planChunkCount') === 3, `${c2.status} ${c2.j.code || ''}`)
    await simulateStall(f2.batchId, 1)
    const first2 = courseIdsOf(await planOps(f2.batchId, 0))
    const later2 = courseIdsOf((await planOps(f2.batchId, 1)).concat(await planOps(f2.batchId, 2)))
    const newRoomOn = async (cid) => (await seriesOf(cid)).filter((x) => x.validFrom === '20271004' && x.status === 'active' && x.roomName === '교실B').length
    check('T28', '(전제) 끊긴 상태: 첫 묶음 수업만 새 장소, 나머지는 아직', (await newRoomOn(first2[0])) === 2 && (await newRoomOn(later2[later2.length - 1])) === 0)
    await bref(f2.batchId).update({ leaseAt: Date.now() })
    const busy = await api(API, kim.token, { action: 'rollback', batchId: f2.batchId, expectedRevision: await revisionNow() })
    check('T23', '발행 중(임대 유효) 배치 원복 → 409 in-progress', busy.status === 409 && busy.j.code === 'in-progress', `${busy.status} ${busy.j.code}`)
    await bref(f2.batchId).update({ leaseAt: LONG_AGO() })
    const list2 = await api(API, kim.token, { action: 'list' })
    const lb = (list2.j.batches || []).find((b) => b.batchId === f2.batchId)
    check('T28', '목록: 멈춘 발행(stalled)과 진행 1/3 묶음', lb?.status === 'committing' && lb.stalled === true && lb.progress?.done === 1 && lb.progress?.total === 3, JSON.stringify(lb))
    // 그 사이 수강 변경(학교 버전 +1) — 남은 묶음의 수업·차시는 그대로
    const add = await api('/api/enrollments', kim.token, { action: 'add', courseId: first2[0], uid: STA })
    const revS = await revisionNow()
    const resume = await api(API, kim.token, { action: 'commit', batchId: f2.batchId, expectedRevision: revS })
    check(
      'T28',
      '멈춘 발행 이어서 하기: 수강 변경으로 학교 버전이 올랐어도 200 committed, 버전 +1',
      add.status === 200 && resume.status === 200 && resume.j.status === 'committed' && (await revisionNow()) === revS + 1,
      `${add.status} ${resume.status} ${resume.j.code || ''} ${resume.j.error || ''}`
    )
    check('T28', '이어서 한 묶음도 반영(마지막 수업도 새 장소 차시 2개)', (await newRoomOn(later2[later2.length - 1])) === 2 && (await newRoomOn(later2[0])) === 2)

    // 다시 수정본: 첫 묶음만 반영된 채 끊긴 뒤, 남은 묶음의 수업을 담당 교사가 고침 → 이어서 하지 않고 원복
    const f3 = await stageAndPreview(kim.token, bigRows(200, '교실C'), { ...T27b, validFrom: '20271101', fileName: '큰파일-3.xlsx' })
    const c3 = await api(API, kim.token, { action: 'commit', batchId: f3.batchId, expectedRevision: f3.pv.j.revision })
    check('T28', '(전제) 두 번째 수정본 확정', c3.status === 200 && c3.j.updated?.length === 200, `${c3.status} ${c3.j.code || ''}`)
    await simulateStall(f3.batchId, 1)
    const first3 = courseIdsOf(await planOps(f3.batchId, 0))
    const later3 = courseIdsOf(await planOps(f3.batchId, 1))
    const upd = await api('/api/courses', kim.token, { action: 'update', courseId: later3[0], title: '과목(담당 수정)' })
    const rs = await api(API, kim.token, { action: 'commit', batchId: f3.batchId, expectedRevision: await revisionNow() })
    check('T28', '끊긴 뒤 남은 묶음의 수업이 다른 곳에서 바뀌면 이어서 하지 않음 → 409 stale-revision', upd.status === 200 && rs.status === 409 && rs.j.code === 'stale-revision' && rs.j.changedCount >= 1, `${upd.status} ${rs.status} ${rs.j.code} ${rs.j.changedCount}`)
    check('T28', '거부 뒤 배치는 그대로 멈춘 상태(원복 가능)', (await bref(f3.batchId).get()).get('status') === 'committing')
    const revR = await revisionNow()
    const rb = await api(API, kim.token, { action: 'rollback', batchId: f3.batchId, expectedRevision: revR })
    check(
      'T23',
      "'committing'(임대 만료) 배치 원복 → 200, 반영된 첫 묶음 수업만 되돌림, 버전 +1",
      rb.status === 200 && rb.j.restored?.length === first3.length && rb.j.skipped?.length === 0 && (await revisionNow()) === revR + 1 && (await bref(f3.batchId).get()).get('rollbackFromStatus') === 'committing',
      `${rb.status} ${rb.j.code || ''} restored=${rb.j.restored?.length} first=${first3.length}`
    )
    const fs3 = await seriesOf(first3[0])
    check('T23', '원복: 첫 묶음 수업은 이전(교실B) 차시가 다시 열리고 이번 배치 차시는 종료', fs3.filter((x) => x.validFrom === '20271004' && !x.validTo && x.status === 'active').length === 2 && fs3.filter((x) => x.validFrom === '20271101').every((x) => x.status === 'retired'), JSON.stringify(fs3.map((x) => [x.validFrom, x.validTo, x.status])))
    const l3 = await sref.collection('courses').doc(later3[0]).get()
    check('T23', '반영되지 않은 묶음의 수업은 건드리지 않음(담당 교사가 고친 이름 유지, 새 차시 없음)', l3.get('title') === '과목(담당 수정)' && (await seriesOf(later3[0])).every((x) => x.validFrom !== '20271101'))
  }

  // ── 목록 ──
  {
    const l = await api(API, kim.token, { action: 'list' })
    const ok = l.status === 200 && Array.isArray(l.j.batches) && l.j.batches.length >= 6 && l.j.batches.length <= 20 && l.j.batches.every((b) => !('rows' in b))
    check('T30', '최근 배치 목록(최대 20, 행 내용 없음)', ok, `${l.status} ${l.j.batches?.map((b) => b.status).join(',')}`)
    const ls = await api(API, st.token, { action: 'list' })
    check('T39', '학생은 배치 목록 조회 불가 → 403', ls.status === 403, `${ls.status}`)
  }
  note('T30', '세 자료 업로드 순서 변경은 행 순서 셔플로 검증(같은 파일 다른 해시 → 결과 동일)')

  await Promise.all([kim, lee, choi, hr4, evil, s2, st].map((x) => x.close()))
  failed = R.finish({ base: process.env.BASE || 'http://127.0.0.1:3100' })
} catch (e) {
  console.error('im1-import 통합 테스트 중단:', e?.stack || e)
  R.finish({ aborted: String(e?.message || e) })
  failed = 1
}
process.exit(failed ? 1 : 0)
