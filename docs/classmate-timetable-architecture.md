# Classmate 개인 시간표 아키텍처

> 대상 저장소: Next.js 16 (pages router) 웹/PWA + Firebase(Web SDK v12, firebase-admin API 라우트).
> 지시서는 Expo/React Native를 가정했지만 이 저장소는 웹 앱입니다. 지시서의 개념을 이 구조에 맞춰 옮겼습니다.
> 이 문서는 구현 기준이며, 실제 코드와 다르면 코드가 아니라 이 문서를 고쳐 맞춥니다.

## 1. 개념과 저장 위치

| 개념 | 저장 위치 | 식별자 | 비고 |
|---|---|---|---|
| 학교 | `schools/{schoolCode}` | NEIS 학교 코드(7자리 영문·숫자) | `scheduleRevision`(단조 증가) — 학생 화면 실시간 갱신 신호 |
| 학기 | `schools/{s}/terms/{termId}` | `2026-1`, `2026-2` | 기간 [startDate, endDate). 문서가 없으면 기본값(1학기 3/1~8/16, 2학기 8/16~다음 해 3/1)으로 계산하고 '기본값'으로 표시 |
| 소속 학급 (Homeroom) | 기존 `classes/{schoolCode}_{학년}_{반}` | classId | 학생 `users.classId`. 수업 그룹(`_g_`)은 소속 학급이 아님(아래 7절) |
| 수업반 (Course) | `schools/{s}/courses/{courseId}` | 자동 생성 id | 과목명·교사명·교실명으로 식별하지 않음 |
| 수업 장소 (Room) | `schools/{s}/rooms/{roomId}` (선택) + 차시의 `roomName` 스냅숏 | roomId | 학급 이름과 같아도 별개 |
| 수강 (Enrollment) | `schools/{s}/enrollments/{courseId}__{uid}` | 결정적 id → 중복 생성 불가 | 상태 active/pending/ended, 기간 [from, to), 출처 |
| 반복 차시 (LessonSeries) | `schools/{s}/series/{seriesId}` | 자동 생성 id | 요일·교시·시각·교실·교사, 적용 기간 [validFrom, validTo) |
| 차시 (Occurrence) | 저장하지 않고 계산 | `${seriesId}@${원래 날짜}` / 보강은 `mk:${id}` | 이동·변경 후에도 같은 id |
| 차시 변경 (Override) | `schools/{s}/overrides/{overrideId}` | 자동 생성 id | 차시의 '최종 상태'. 같은 차시는 revision 최대만 유효 |
| 변경 묶음 (ChangeSet) | `schools/{s}/changeSets/{changeSetId}` | `cs_${mutationId}` | 교시 교환 등 여러 변경을 한 번에 발행. 재요청 시 같은 결과 |
| 감사 로그 | `schools/{s}/audit/{id}` | 자동 | 변경자 uid, 시각, 범위, 전후, 사유, revision (토큰·개인정보 없음) |
| 개인 일정 | `users/{uid}/personalEntries/{entryId}` | 자동 | 본인만 읽기·쓰기 |
| 초대 | `invitations/{code}` | 사람이 입력 가능한 8자 코드 | 학급(homeroom)·수업(course) 구분, 만료·회수·사용 수 |
| 초대 사용 기록 | `invitations/{code}/uses/{uid}` | uid | 중복 수락을 같은 결과로 |
| 가져오기 배치 | `schools/{s}/importBatches/{batchId}` (+ `rows` 하위 컬렉션) | 자동 | staged → committed / cancelled / rolled-back |
| 수강 명단 행 | `schools/{s}/rosterEntries/{id}` | 자동 | 미가입 학생은 미연결 상태로 보관 |

기존 저장 위치(`classes/{id}/info/timetable`, `overrides/{ymd}`, `school_timetables`, NEIS)는 그대로 두고 **'학급 시간표(참고)'** 보기와 이전(마이그레이션)의 원본으로만 씁니다. 개인 시간표는 위 새 모델로만 계산합니다.

## 2. 기간·날짜 규칙

- 날짜는 학교 시간대(현재 모든 학교 Asia/Seoul) 기준 `YYYYMMDD` 문자열. 서버 시각(Timestamp)과 구분합니다.
- 모든 기간은 **시작일 포함, 종료일 미포함** [from, to). 비어 있으면 열린 구간.
- 수강 자격은 **실제 진행일** 기준: 다른 날로 옮겨진 차시는 옮겨 간 날짜에 수강 중인 학생에게만 보입니다.
- 기본 시간표 변경(적용일 X부터): 기존 반복 차시의 `validTo = X`, 새 반복 차시 `validFrom = X`. 과거 날짜는 당시 차시로 계산됩니다.

## 3. 개인 시간표 계산 (src/lib/timetable/engine.ts)

순수 함수 `buildDayTimetable(input)` 하나로 계산합니다. 화면·서버·브리핑이 같은 엔진을 씁니다.

1. 수강 대상 = D에 유효한 수강 + D에 유효한 소속 학급의 **명시된** 공통 수업(`course.commonForHomerooms`). courseId로 중복 제거(개별 수강 우선).
   - 수강 유효: `active`이고 [from, to) 안, 또는 `ended`이면서 `to`가 있고 거절(`rejected`)이 아닌 수강의 [from, to) 안(종료해도 지난 날짜에는 그대로 보임). 거절·승인 대기 중 종료(`to` 없음)는 어느 날짜에도 보이지 않음.
   - 수업 운영: `courseActiveOn`(status·`endedOn`). `/api/timetable/me`는 수업의 학기 끝을 `endedOn`으로 잘라 보내고, 조회 시작 전에 학기가 끝난 공통 수업은 보내지 않음. 반복 차시가 D 전에 모두 끝난 수업은 D에 수업이 없으면 '운영 중'으로 세지 않음(그 수업에 연결한 개인 일정이 다시 보임, '일부 미등록' 오탐 없음).
2. 그 수업들의 반복 차시 중 D의 요일·적용 기간에 맞는 것 → 기본 차시.
3. 차시별 유효 변경 = 발행된 변경 중 revision 최대(동률이면 overrideId 사전순). 배열 순서와 무관 → 재전송·순서 역전에도 같은 결과.
   - `cancel`: 실제 수업 목록에서 빼고 안내 행(`notices`)으로.
   - `reschedule`: 최종 상태(날짜·교시·시각·교실·교사). 날짜가 D가 아니면 D에는 '옮겨 감' 안내만, 새 날짜에만 수업으로 한 번.
   - `restore`: 기본 상태. 강조 없음(서버에 이력은 남음).
   - `makeup`: 기본에 없던 차시(`mk:` id). 보강의 취소·이동 안내도 그날 수강 중인 학생에게만.
4. 다른 날에서 D로 옮겨 온 차시도 포함(원래 차시 id 유지).
5. 쉬는 날(NEIS 학사일정 휴업일·공휴일·방학): 변경이 명시되지 않은 기본 차시는 표시하지 않음. 보강·이동해 온 차시는 표시.
6. 대상 반복 차시가 사라진 변경(기본 시간표 변경 등)은 `orphanOverrides`로 반환 — 조용히 버리지 않고 교사 화면에서 검토.
7. 개인 일정: `linkedCourseId`가 수강 중인 수업이면 개인 일정 대신 공식 수업을 표시하고 메모만 붙임. 연결되지 않은 일정은 `source:'personal', synced:false`.
8. 실제 시각(명시 시각 → 학급 교시표 → 학교급 기본 교시표) 기준 정렬, 겹침 검출(`conflicts`).
9. 변경 전후 비교(`change.fields`: date/time/room/teacher) — 빨간색 강조 + 텍스트 배지.

**변경 우선순위:** 날짜 예외(override)는 그 날짜에 유효한 기본 차시 위에 적용됩니다. 기본 시간표가 바뀌어 대상 차시가 없어지면 그 예외는 적용하지 않고 검토 대상(orphan)으로 표시합니다.

## 4. 데이터 형식

```ts
// schools/{s}
{ name, kind /* SCHUL_KND_SC_NM */, officeCode, timezone: 'Asia/Seoul', scheduleRevision: number, updatedAt }

// schools/{s}/terms/{termId}
{ name: '2026학년도 2학기', startDate: 'YYYYMMDD', endDate: 'YYYYMMDD', isDefault?: boolean }

// schools/{s}/courses/{courseId}
{ schoolCode, termId, title, subject, section?, teacherUids: string[], teacherNames: string[],
  managerUids?: string[] /* 관리만 맡은 계정(예: 학급 시간표로 공통 수업을 만든 담임) — 일정 변경·수강 관리 가능, 교사 충돌 판정에는 쓰지 않음 */,
  status: 'active'|'ended', endedOn?: 'YYYYMMDD'|null, commonForHomerooms: string[],
  defaultRoomId?, defaultRoomName?, invitePolicy: 'auto'|'approval',
  catalogVisible: boolean /* 학생 '공식 수업 선택' 목록 노출 */,
  legacyGroupId?: string /* 예전 수업 그룹(classes/{base}_g_{x}) — 톡방·공지 연결 */,
  source: 'manual'|'import'|'legacy-group'|'homeroom-common', importBatchId?, createdBy, createdAt, updatedAt, revision,
  /* 가져오기 전용 */ importKey?, importLinkedUids? /* 발행 교사가 확인한 교사 연결 */, importCommon? /* 공통 수업 '후보' 학급 — 담임이 setCommon으로 확인해야 commonForHomerooms가 됨 */,
  classLabels?, importRetiredOn?, rolledBackBy? }

// schools/{s}/series/{seriesId}
{ courseId, termId, weekday: 1..7, period, start?, end?, roomId?, roomName?, teacherUids?, teacherNames?,
  validFrom, validTo|null, status: 'active'|'retired' /* 끝낸 차시는 retired + validTo */, importBatchId?, importClosedBy?, rolledBackBy?,
  sourceHomeroomId? /* 학급 시간표에서 만든 차시 */, supersededBy?/replacesSeriesId?/changeSetId? /* 기본 변경 */, createdBy, createdAt }

// schools/{s}/enrollments/{courseId}__{uid}
{ courseId, uid, schoolCode, termId, status: 'active'|'pending'|'ended', from?, to?,
  source: 'invite'|'roster'|'request'|'admin'|'legacy-group', invitationCode?, via? /* 'group-qr' */, rosterEntryId?,
  history? /* 끝난 수강을 다시 열 때 이전 상태 */, createdAt, updatedAt, decidedBy? }

// schools/{s}/importBatches/{batchId} (+ rows/{n}, plan/{n})  — 시간표 가져오기 배치: staged → committing → committed | failed | cancelled | rolled-back
// schools/{s}/rosterBatches/{batchId} (+ rows/{n})           — 수강 명단 임시 적재
// schools/{s}/rosterEntries/re_{sha1(학기|학급|번호|수업표기)}  — 명단 행(학생 이름 포함 → 같은 학교 교사만 읽기), linkedUid는 담임·담당 교사가 확정할 때만

// schools/{s}/overrides/{overrideId}
{ courseId, occurrenceKey, changeSetId, kind: 'cancel'|'reschedule'|'makeup'|'restore',
  seriesId?, originalDate?, target?: { date, period, start?, end?, roomId?, roomName?, teacherUids?, teacherNames? },
  changeSetKeys: string[] /* 같은 묶음의 `${courseId}|${occurrenceKey}` 전부 — 학생 자료에 일부만 있으면 묶음 전체를 적용하지 않음 */,
  dates: string[] /* 조회용: 원래 날짜 ∪ 목표 날짜 ∪ 변경 전 날짜 ∪ 같은 차시 이전 변경들의 dates ∪ 같은 묶음 전체 날짜 */, reason?, revision, status: 'published'|'withdrawn' /* 'published'가 아니면 적용 안 함 */,
  publishedAt: Timestamp, createdBy }

// schools/{s}/changeSets/{cs_<mutationId>}
{ mutationId, scope: 'date'|'base', status: 'published'|'pending-approval'|'rejected',
  items: [...요청 원문 요약], overrideIds: string[], seriesChanges?: {retired: string[], created: string[]},
  reason, createdBy, createdAt, revision, affectedCourseIds, affectedDates, affectedStudentCount,
  conflicts: ResourceConflict[], approvals?: {uid: boolean} }

// users/{uid}/personalEntries/{entryId}
{ title, kind: 'weekly'|'once', weekday?, date?, period?, start?, end?, roomName?, memo?, linkedCourseId?: string|null,
  createdAt, updatedAt }

// invitations/{code}   — 8자 코드(헷갈리는 문자 제외), 표시 XXXX-XXXX, 링크 /i/{code}. 클라이언트 읽기·쓰기 금지(API만)
{ code, schoolCode, schoolName, officeCode, termId, type: 'homeroom'|'course', targetId /* classId 또는 courseId */, targetLabel,
  teacherName, issuedBy, issuedByName, createdAt, expiresAt|null, revoked: boolean, revokedAt?, revokedBy?,
  uses: number, maxUses: number|null /* 기본 null = 여러 학생이 같은 코드 사용 */, lastUsedAt? }
// invitations/{code}/uses/{uid} — { at, type, result } (처음 수락할 때만, 같은 트랜잭션에서 uses +1)
```

## 5. 서버 API 계약

모든 API: `Authorization: Bearer <Firebase ID token>`(미리보기 제외), JSON, 오류는 `{ error: 한국어 문구, code: 기계용 코드 }`. 권한은 서버가 `users/{uid}`(role, schoolCode)와 대상 문서로 판정하고 클라이언트 값(역할 선택, localStorage)은 믿지 않습니다. 실패를 빈 결과로 위장하지 않습니다.

| API | 메서드·본문 | 권한 | 결과 |
|---|---|---|---|
| `/api/timetable/me` | GET `?from=YYYYMMDD&to=YYYYMMDD` (최대 21일) | 로그인 학생(교사도 본인 수강이 있으면 가능) | `MyTimetablePayload` (6절). 조회 실패는 5xx + code |
| `/api/courses` | POST `{action}` — `list`(학교·학기 수업 목록 + 수업별 인원 수 `counts{active,pending}` — 명단 없음), `get`, `create`, `update`, `end`, `setCommon`, `addSeries`, `retireSeries`, `fromHomeroomTimetable`(담임: 학급 시간표 → 공통 수업, 결정적 id `hc_{classId}_{sha1(termId|과목|교사)[0:10]}`·차시 `hcs_…` — src/lib/timetable/ids.ts), `catalog`(학생용 공개 목록) | create: 같은 학교 교사(자기 자신을 담당 교사로). update/end/series: 담당 교사 또는 관리 교사(managerUids). `addSeries.validFrom`·`retireSeries.effectiveFrom`·`fromHomeroomTimetable.effectiveFrom`이 오늘보다 이르면 400 `past-date`(지난 시간표를 소급해 바꾸지 않음). 기본 변경으로 옮긴 공통 수업 칸은 `fromHomeroomTimetable` 재실행이 다시 만들지 않음(`replacesSeriesId`/`supersededBy` 연결, `sourceHomeroomId` 유지) | 수업·차시 |
| `/api/enrollments` | POST `{action}` — `request`(학생, 공개 수업 신청 → pending), `approve`/`reject`/`end`(담당 교사), `add`(담당 교사가 학생 uid 연결 — 같은 학교 학생만), `list`(담당 교사: 수강생 목록, 학생: 본인) | 위 | 수강 |
| `/api/invitations` | POST `{action}` — `create`(type, targetId, expiresInDays? 1~180 기본 30, maxUses?), `revoke`, `list`({targetId}), `preview`({code}, 인증 불필요, 최소 정보 + state: ok/not-found/expired/revoked/used-up/ended), `accept`({code, name?, studentId?}) | create/revoke/list: 대상 학급 담임 또는 수업 담당·관리 교사. accept: 로그인 학생 — 프로필 없는 가입 직후 계정도 허용(수업 초대면 classId:null 학생 프로필 생성, 소속 학급은 비워 둠), 익명·교사 계정 403. 시도 제한(IP·uid 실패 횟수) | 초대 |
| `/api/join`, `/api/join-info` | 기존 `/join?c=&t=`(10분 토큰) 호환 | 같은 규칙(`planClassJoin`)을 초대 수락과 공유. 신청 중 학생이 그룹 QR → 원래 학급 신청 유지·`extraClassIds`만 추가(`joined-extra-pending`). 그룹에 연결된 수업(`legacyGroupId`)이 있으면 수강 생성 | 입장 |
| `/api/schedule-changes` | POST `{action}` — `preview`/`publish`(아래), `approve`/`reject`(다른 교사 수업이 포함된 요청), `list`(수업별 이력) | 담당 교사(모든 대상 수업). 일부만 담당이면 `pending-approval` | 변경 묶음 |
| `/api/timetable-import` | POST `{action}` — `stage`(정규화 행), `preview`, `commit`({batchId, expectedRevision, acceptReview?, confirmTeacherLinks?: [{nameKey, uid}]}), `cancel`, `rollback`, `list` | 같은 학교 교사 | 배치. stale 판정은 학교 버전이 아니라 '수업·차시 계획 또는 교사 후보 매핑'이 바뀌었을 때(수강 변경만으로는 막히지 않음). 형식·규칙은 `docs/classmate-import-format.md` |
| `/api/roster-import` | POST `{action}` — `stage`, `preview`, `commit`, `cancel`, `link`({entryIds, confirm:true} — 서버가 후보를 다시 계산, 클라이언트 uid 받지 않음), `list` | 같은 학교 교사(연결 확정은 그 학생의 담임 또는 그 수업 담당·관리 교사) | 명단 |

### 5.1 변경 발행 본문

```ts
{
  action: 'preview' | 'publish',
  schoolCode, mutationId /* 클라이언트가 만든 uuid — 재전송 시 같은 결과 */, expectedRevision /* 화면이 본 schools/{s}.scheduleRevision */,
  scope: 'date' | 'base', reason,
  items: Array<
    | { op: 'cancel', courseId, occurrenceKey }
    | { op: 'reschedule', courseId, occurrenceKey, target: SlotState }   // 같은 날 교시 이동, 날짜 이동, 교실·교사 변경
    | { op: 'restore', courseId, occurrenceKey }
    | { op: 'makeup', courseId, target: SlotState }
    | { op: 'base', courseId, seriesId, effectiveFrom, weekday?, period?, start?, end?, roomName?, teacherNames? } // scope=base
  >,
  acknowledgeConflicts?: boolean
}
```

처리 순서(구현 `src/lib/timetable/changes.ts`·`src/pages/api/schedule-changes.ts`): ① `cs_${mutationId}`가 이미 있으면 저장된 결과를 그대로 반환(`replayed:true` — 첫 요청이 버전을 올리므로 재전송 확인을 버전 확인보다 먼저; 다른 교사·다른 내용으로 같은 id를 쓰면 409 `mutation-id-reused`). ② 현재 `scheduleRevision` ≠ `expectedRevision` → 409 `stale-revision`(+`currentRevision`, 덮어쓰지 않음). ③ 슬롯 검증(교시 범위, 시각 순서, 학기 범위, 종료된 수업 금지, 다른 학교 교사 계정 금지). ④ 최종 상태(기존 유효 변경 + 이번 변경)로 교사·교실·학생 충돌 검사 — 묶음 전체 적용 후 기준이라 정상 교환은 통과. 충돌이 있고 `acknowledgeConflicts`가 아니면 409 `conflicts`(승인 요청보다 먼저). ⑤ 권한: 모든 대상 수업의 담당 교사 또는 관리 교사(`managerUids`)면 발행, 아니면 changeSet `pending-approval`(그 수업의 담당·관리 교사 전원 승인 필요) + 202. 승인은 트랜잭션 안에서 최신 승인 목록에 합쳐 전원 승인이면 같은 요청에서 발행(동시 승인도 멈추지 않음). 승인 시점에 다시 검사해 요청 때 저장한 충돌에 없던 **새 충돌**이 있으면 승인자에게 409 `conflicts`(승인자가 확인해야 발행). ⑥ 트랜잭션 하나에 변경·기본 차시 종료/생성·묶음·감사 기록, `scheduleRevision` +1. ⑦ 커밋 후 영향 학생에게만 알림(묶음당 1건, 알림 id `sched_${changeSetId}`, 링크 `/student/timetable?date=가장 이른 변경 날짜`). 승인 요청 알림은 `schedreq_${changeSetId}`, 링크 `/teacher/schedule-changes?changeSetId=…`.

결정적 id: 묶음 `cs_<mutationId>`, 변경 `ov_<mutationId>_<i>`, 보강 차시 키 `mk:<mutationId>-<i>`, 새 반복 차시 `sr_<mutationId>_<i>`(기존 차시는 `validTo`=적용일·`status:'retired'`·`supersededBy`).

`preview`는 ①~⑤만 하고 `{ before/after 목록, affectedStudentCount, conflicts, orphans }`를 돌려줍니다(학생 명단은 노출하지 않음).

## 6. 학생 화면 데이터 (`/api/timetable/me`)

```ts
interface MyTimetablePayload {
  revision: number                // schools/{s}.scheduleRevision
  generatedAt: number
  schoolCode: string | null
  from: string; to: string        // 조회 기간(둘 다 포함)
  term: { termId, name, startDate, endDate, isDefault }       // from 날짜의 학기
  terms: Array<{ termId, name, startDate, endDate, isDefault }> // 조회 기간에 걸친 학기 전부 — 날짜별 '학기 밖' 판정용
  homeroom: { classId, label, schoolName, isGroupLegacy: boolean } | null   // 그룹이 소속처럼 저장된 예전 데이터는 isGroupLegacy
  homerooms: HomeroomMembership[]
  enrollments: Enrollment[]       // 본인 것만
  courses: Course[]               // 본인 수강 + 소속 학급 공통 수업만 (학교 전체 아님)
  series: LessonSeries[]
  overrides: Override[]           // 조회 기간에 걸친 차시의 변경 전부(차시별 이력 포함) + 같은 묶음의 다른 차시 변경
                                  // (기간 필터를 차시 단위로 적용 — 기간 밖으로 다시 옮긴 최신 변경이 빠져 예전 변경이 살아나지 않게. engine.selectOverridesForWindow)
  offDays: Record<YYYYMMDD, { name: string } | null>   // 조회 실패한 날짜는 키가 없음 → calendarErrors
  calendarErrors: string[]
  periodTimes: PeriodTime[]
  legacyClassTimetableAvailable: boolean  // '학급 시간표(참고)' 보기를 보여 줄지
}
```

클라이언트는 이 자료 + 본인 개인 일정(Firestore 직접)으로 날짜마다 `buildDayTimetable`을 실행합니다. 캐시 키: `uid · schoolCode · termId · 기간 · revision`. 로그아웃·계정 전환 시 캐시 삭제. `schools/{s}` 문서의 `scheduleRevision`을 구독해 값이 바뀌면 다시 받습니다(교시 교환 묶음이 한 번에 반영됨).

## 7. 기존 데이터와의 관계

- **수업 그룹(`classes/{base}_g_{x}`)**: 톡방·공지·명단 공간으로 유지. 수업반과는 `course.legacyGroupId`로 연결. 연결된 수업의 초대를 수락하면 그룹 `extraClassIds`에도 추가해 톡방·공지 접근을 유지합니다.
- **그룹을 소속처럼 가진 학생**(`users.classId`가 `_g_`): 소속 학급을 그룹 원본 반으로 추정하지 않습니다. 화면에 '소속 학급 미설정'으로 표시하고 담임 QR 안내를 보여 줍니다. 마이그레이션은 이 학생들을 그룹과 연결된 수업의 수강으로 옮기고 소속은 '확인 필요'로 남깁니다.
- **학급 시간표(`info/timetable`, NEIS 학급 시간표)**: 개인 시간표가 아닙니다. 개인 시간표에 연결된 수업이 없으면 '학급 시간표(참고)'를 **별도 표시·명확한 이름**으로만 보여 줍니다. 담임이 '우리 반 학생 모두 같은 수업'이라고 명시하면(`/api/courses` `fromHomeroomTimetable` — 이 경로만. 마이그레이션 스크립트는 담임 확인을 대신하지 않음) 학급 시간표에서 공통 수업(`commonForHomerooms`)을 만들어 개인 시간표에 연결합니다.
- **저녁 '내일 가방' 알림**: 학급 시간표로 만든 문구라 학생에게는 '학급 시간표 기준 … · 내 수업은 앱에서 확인하세요'로 보내고 `/student/timetable?date=내일`로 연결합니다(개인 시간표처럼 보내지 않음).
- **교환·SOS의 `classes/{id}/overrides/{ymd}`**: 학급 시간표(참고) 보기에서만 씁니다. 새 변경 기능은 수업반 차시 변경(`schools/{s}/overrides`)을 씁니다.

## 8. 보안 규칙 요약

| 경로 | 읽기 | 쓰기 |
|---|---|---|
| `schools/{s}` | 같은 학교 로그인 사용자 | 서버만 |
| `schools/{s}/enrollments/{id}` | 본인(`resource.data.uid == auth.uid`), 같은 학교 교사 | 서버만 |
| `schools/{s}/courses|series|overrides|terms|rooms` | 같은 학교 교사 | 서버만 |
| `schools/{s}/changeSets|audit|importBatches|rosterBatches|rosterEntries` | 같은 학교 교사 | 서버만 |
| `users/{uid}/personalEntries/{id}` | 본인 | 본인 — 허용 키만(title 1~40, kind weekly(weekday 1~7)/once(date YYYYMMDD), period 0~10|null, start/end HH:MM|null이고 둘 다 있으면 start<end, roomName ≤30, memo ≤200, createdAt(생성 시 request.time)/updatedAt(수정 시 request.time)). `linkedCourseId`는 본인 학교 `enrollments/{id}__{uid}`가 active일 때만, 수정 때는 값이 바뀔 때만 다시 검사(수강이 끝나도 메모 수정·연결 해제 가능) |
| `users/{uid}/notifications/{id}` | (기존 규칙) | 클라이언트 생성은 addDoc 자동 id(20자 영숫자)만 — 서버 중복 방지 id(`sched_…`, `schedreq_…`, `join_…` 등)를 선점하지 못하게 |
| `invitations/**` | 서버만(미리보기는 API) | 서버만 |
| 그 밖의 `schools/{s}` 하위(`rosterBatches` 등) | 기본 거부 | 서버만 |

학생의 공식 시간표 읽기는 `/api/timetable/me`가 수강 범위만 돌려줍니다 — 학생이 학교 전체 시간표나 다른 학생 수강 정보를 읽는 경로가 없습니다. 교사·학생 모두 자기 users 문서에 권한 필드(`isSchoolAdmin, schoolAdmin, isAdmin, admin, roles, permissions, claims, adminSchoolCodes`)를 쓸 수 없습니다. 교사가 스스로 쓰는 `masterName`은 권한 근거로 쓰지 않습니다(가져오기 교사 연결은 발행 교사 확인 필요).

규칙 테스트: `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node --test tests/rules/`. 에뮬레이터는 `env -u HTTPS_PROXY -u https_proxy firebase emulators:start …`로 띄워야 규칙 파일 변경 시 다시 읽기가 프록시 때문에 실패해 종료되지 않습니다.

## 9. 인덱스 (`firestore.indexes.json`, 복합만)

| 컬렉션 | 필드 | 쓰는 쿼리 |
|---|---|---|
| classes | (schoolCode, grade, classNm) — 꼭 필요 | `/teacher/view-timetables` 학급 목록(schoolCode 등호 + grade·classNm 정렬). 이 파일보다 먼저 있던 쿼리라 운영에는 콘솔에서 만든 같은 인덱스가 있을 것 — 파일에 적어 두어 배포 때 삭제 후보로 뜨지 않게 함 |
| changeSets | (affectedCourseIds CONTAINS, createdAt DESC) — 꼭 필요 | `/api/schedule-changes` list(courseId): 수업별 변경 이력 |
| enrollments | (courseId, status) | `studentUidsForCourses`(courseId in + status) |
| courses | (termId, catalogVisible) | `/api/courses` 공개 수업 목록(catalog) |
| users | (classId, role, status) | 학급 학생 찾기(`studentUidsForCourses`, `chat-push`, `evening-brief`) |

'꼭 필요'가 아닌 셋은 등호 조건만이라 자동 단일 필드 인덱스 병합으로도 돌지만, 쿼리가 실제로 쓰므로 성능용으로 둡니다. 쓰는 쿼리가 없는 복합 인덱스는 두지 않습니다 — enrollments(uid, status), courses(commonForHomerooms CONTAINS, status)·(termId, catalogVisible, status), series(courseId, validFrom), overrides(courseId, status)는 쓰는 쿼리가 없어 뺐습니다(쓰기마다 인덱스 항목만 늘어남). `src/`·`scripts/`에 컬렉션 그룹 쿼리가 없으므로 COLLECTION_GROUP 범위 인덱스나 `fieldOverrides`도 필요 없습니다. 내 승인 대기 목록(`approverUids` CONTAINS + `status` 등호, 정렬은 메모리)도 등호 조건만이라 복합 인덱스가 필요 없습니다. 쿼리에 범위 조건이나 다른 필드 정렬을 붙이면 이 표와 파일을 함께 고칩니다.

단일 필드 조건·정렬(`importBatches.createdAt`, `teacherUids` CONTAINS, `invitations.targetId`, `courses.legacyGroupId` 등)은 자동 인덱스로 충분합니다. 에뮬레이터는 복합 인덱스를 강제하지 않으므로 충분성은 스테이징/운영 프로젝트에서 확인해야 합니다. 배포 시 콘솔에만 있는 기존 인덱스를 지울지 묻는데 `--force`를 쓰지 말고 `firebase firestore:indexes --project classmate-mvp-9f855`로 먼저 비교합니다. 운영에만 있는 인덱스가 아직 쓰이면 파일에 옮기고, 삭제 질문에는 No로 답합니다. 위에서 뺀 다섯 개가 이미 운영에 배포돼 있었다면 비교로 확인한 뒤에만 지웁니다(배포는 별도 승인).
