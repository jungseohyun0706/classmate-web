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
  catalogVisible: boolean /* 학생 '수업 담기' 목록 노출 */, grades?: number[] /* 대상 학년 1~6 — 없으면 학년 미상(모든 학년에 보임) */,
  gradesBy?: 'teacher'|'import' /* 대상 학년을 정한 쪽 — 'teacher'면 가져오기가 덮어쓰거나 지우지 않음(11절) */,
  classLabels?: string[] /* 대상 반 '2-1'(학년·반 순), 없으면 학년 규칙(11절). 가져오기는 수업 칸의 학급 표시로 채움.
                           반별 수업인지 여러 반·선택 수업인지는 개수가 아니라 출처로(courseClassScope — 가져오기의 한 학급 'hr' 수업·
                           교사가 한 반만 정한 수업만 반별, 분반·수업 코드 수업은 한 반이어도 선택·이동) */,
  classLabelsBy?: 'teacher'|'import' /* 대상 반을 정한 쪽 — 'teacher'면 가져오기가 덮어쓰거나 지우지 않고 원복도 건드리지 않음(11절) */,
  catalogBy?: 'teacher'|'import'|'import-legacy' /* 공개·참여 방식을 마지막으로 정한 쪽 — 'teacher'(공개·참여 방식·수업 그룹을 교사가 바꿈)면
                                                    가져오기가 덮어쓰지 않음, 'import-legacy'는 표시 없던 예전 가져오기 수업(참여 방식 '승인 후' 고정)(11절) */,
  importRetiredOn?: YYYYMMDD /* 가져오기(바꾸기)가 정리한 날 — 그날부터 공개 목록·담기에서 빠짐 */,
  legacyGroupId?: string /* 예전 수업 그룹(classes/{base}_g_{x}) — 톡방·공지 연결 */,
  source: 'manual'|'import'|'legacy-group'|'homeroom-common', importBatchId?, createdBy, createdAt, updatedAt, revision,
  /* 가져오기 전용 */ importKey?, importLinkedUids? /* 발행 교사가 확인한 교사 연결 */, importCommon? /* 공통 수업 '후보' 학급 — 담임이 setCommon으로 확인해야 commonForHomerooms가 됨 */,
  importRetiredOn?, rolledBackBy? }

// schools/{s}/series/{seriesId}
{ courseId, termId, weekday: 1..7, period, start?, end?, roomId?, roomName?, teacherUids?, teacherNames?,
  validFrom, validTo|null, status: 'active'|'retired' /* 끝낸 차시는 retired + validTo */, importBatchId?, importClosedBy?, rolledBackBy?,
  sourceHomeroomId? /* 학급 시간표에서 만든 차시 */, supersededBy?/replacesSeriesId?/changeSetId? /* 기본 변경 */, createdBy, createdAt }

// schools/{s}/enrollments/{courseId}__{uid}
{ courseId, uid, schoolCode, termId, status: 'active'|'pending'|'ended', from?, to?,
  source: 'invite'|'roster'|'request'|'admin'|'legacy-group', invitationCode?, via? /* 'group-qr' */, rosterEntryId?,
  history? /* 끝난 수강을 다시 열 때 이전 상태 — 그중 들은 기간(끝낸 수강의 [from, to))은 엔진이 지난 날짜에 그대로 보여 줌(past) */,
  createdAt, updatedAt, decidedBy?, leftBy?, leftAt?, leftOn? /* 학생이 직접 뺀 수강(leave) — 같은 수업은 하루 한 번 */,
  reapproval? /* 선생님이 끝내거나 거절한 뒤 다시 신청한 수강 — 학생이 빼도 남아 다음 참여도 승인 대기, 선생님 승인·추가로 해제 */ }

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
| `/api/timetable/teacher` | GET `?from=YYYYMMDD&to=YYYYMMDD` (최대 21일, 기본 어제~13일 뒤) | 로그인 교사(학교 있음). 학생 403 `teacher-only`, 가입 미완료 403 `no-profile`, 학교 없음 409 `no-school` | `TeacherTimetablePayload` (10절) — 본인 차시만. 조회 실패는 5xx + code |
| `/api/courses` | POST `{action}` — `list`(학교·학기 수업 목록 + 수업별 인원 수 `counts{active,pending}` — 명단 없음), `get`, `create`, `update`, `end`, `setCommon`, `addSeries`, `retireSeries`, `fromHomeroomTimetable`(담임: 학급 시간표 → 공통 수업, 결정적 id `hc_{classId}_{sha1(termId|과목|교사)[0:10]}`·차시 `hcs_…` — src/lib/timetable/ids.ts), `catalog`(학생 '수업 담기' 공개 목록 — 11절). `create`/`update`는 `grades`(대상 학년 1~6, 선택)를 받고 정하면 `gradesBy:'teacher'`, `classLabels`(대상 반, '2-1'·'2학년 1반'·'201'을 '2-1'로 정리 — 알 수 없는 표시는 400 `invalid-class-label`)를 받고 정하면 `classLabelsBy:'teacher'`, `update`로 공개·참여 방식이나 예전 수업 그룹(`legacyGroupId`)을 바꾸면 `catalogBy:'teacher'` | create: 같은 학교 교사(자기 자신을 담당 교사로). update/end/series: 담당 교사 또는 관리 교사(managerUids). `addSeries.validFrom`·`retireSeries.effectiveFrom`·`fromHomeroomTimetable.effectiveFrom`이 오늘보다 이르면 400 `past-date`(지난 시간표를 소급해 바꾸지 않음). 기본 변경으로 옮긴 공통 수업 칸은 `fromHomeroomTimetable` 재실행이 다시 만들지 않음(`replacesSeriesId`/`supersededBy` 연결, `sourceHomeroomId` 유지) | 수업·차시 |
| `/api/enrollments` | POST `{action}` — `request`(학생, 공개 수업 하나), `requestMany`(학생 '수업 담기', `{courseIds}` 최대 20개 — 수업마다 결과), `leave`(학생, 내가 담은 수업 빼기), `approve`/`reject`/`end`(담당 교사), `add`(담당 교사가 학생 uid 연결 — 같은 학교 학생만), `list`(담당 교사: 수강생 목록, 학생: 본인) | 학생 동작은 학생 계정만(교사 403 `student-only`), uid별 10분 20회·빼기는 따로 1시간 10회(429 `rate-limited`), 같은 수업 빼기는 하루 한 번(429 `left-today`). 나머지 위 | 수강(11절) |
| `/api/invitations` | POST `{action}` — `create`(type, targetId, expiresInDays? 1~180 기본 30, maxUses?), `revoke`, `list`({targetId}), `preview`({code}, 인증 불필요, 최소 정보 + state: ok/not-found/expired/revoked/used-up/ended), `accept`({code, name?, studentId?}) | create/revoke/list: 대상 학급 담임 또는 수업 담당·관리 교사. accept: 로그인 학생 — 프로필 없는 가입 직후 계정도 허용(수업 초대면 classId:null 학생 프로필 생성, 소속 학급은 비워 둠), 익명·교사 계정 403. 시도 제한(IP·uid 실패 횟수) | 초대 |
| `/api/join`, `/api/join-info` | 기존 `/join?c=&t=`(10분 토큰) 호환 | 같은 규칙(`planClassJoin`)을 초대 수락과 공유. 신청 중 학생이 그룹 QR → 원래 학급 신청 유지·`extraClassIds`만 추가(`joined-extra-pending`). 그룹에 연결된 수업(`legacyGroupId`)이 있으면 수강 생성 | 입장 |
| `/api/schedule-changes` | POST `{action}` — `preview`/`publish`(아래), `approve`/`reject`(다른 교사 수업이 포함된 요청), `list`(수업별 이력) | 담당 교사(모든 대상 수업). 일부만 담당이면 `pending-approval` | 변경 묶음 |
| `/api/timetable-import` | POST `{action}` — `stage`(정규화 행), `preview`, `commit`({batchId, expectedRevision, acceptReview?, confirmTeacherLinks?: [{nameKey, uid}], catalog?: {visible, policy}}), `cancel`, `rollback`, `list` | 같은 학교 교사 | 배치. stale 판정은 학교 버전이 아니라 '수업·차시 계획 또는 교사 후보 매핑'이 바뀌었을 때(수강 변경만으로는 막히지 않음). 형식·규칙은 `docs/classmate-import-format.md` |
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
- **저녁 '내일 가방' 알림**: 학급 시간표로 만든 문구라 학생에게는 '학급 시간표 기준 … · 내 수업은 앱에서 확인하세요'로 보내고 가방 체크리스트가 있는 `/student/today?date=내일`로 연결합니다(개인 시간표처럼 보내지 않음).
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

## 10. 교사 내 시간표(메인 화면) (`/dashboard`, `/api/timetable/teacher`)

선생님 화면 메인(`/dashboard`)은 담임 반 학급 시간표가 아니라 **선생님 본인 시간표('오늘의 내 수업')**입니다. 학교가 있는 모든 교사에게 보이고(담임 아니어도), 학급 시간표는 담임에게만 카드 머리의 작은 링크 '우리 반 시간표 보기'(`/teacher/class-timetable`)로 남깁니다. 급식·학사일정은 `TodayCard showTimetable={false}`로 그대로 아래에 둡니다.

**자료(서버, `src/lib/timetable/teacherData.ts`)** — 다른 학생·교사 자료를 내려주지 않습니다.

```ts
interface TeacherTimetablePayload {        // src/lib/timetable/teacherDay.ts
  revision: number                          // schools/{s}.scheduleRevision(조회 전에 읽음)
  generatedAt: number
  schoolCode: string
  from: string; to: string                  // 둘 다 포함
  terms: TermSummary[]                      // /me와 같은 규칙(termsForWindow)
  offDays: Record<YYYYMMDD, { name } | null>          // 학교 전체가 쉬는 날(아래 '쉬는 날' 참고 — 담임 학년으로 정하지 않음)
  gradeOffDays: Record<YYYYMMDD, { name, grades: number[] }>  // 일부 학년만 쉬는 날(예: '3학년 재량휴업일')
  calendarErrors: string[]                  // 학사일정 확인 실패(상한 4초 — /me와 같음)
  periodTimes: PeriodTime[]                 // 담임 학급 교시표(classes/{id}.teacherId = 나, 같은 학교) → 학교 엑셀 교시표(school_timetables.periodTimes) → 학교급 기본
  days: Record<YYYYMMDD, { hasOfficial, lessons: TeacherLesson[], notices: TeacherNotice[], incomplete }>
  mySchedule: { mon..fri: string[7] } | null   // 예전 주간 시간표(users.mySchedule), 모두 비면 null
  covers: TeacherCover[]                    // 예전 교환·보결 중 수락·배정되고 내가 요청했거나 맡은 것
}
```

- **내 차시 판정은 uid로만**: 후보 수업 = `courses.teacherUids` array-contains 내 uid + `series.teacherUids` array-contains 내 uid + 조회 기간 날짜의 변경(`overrides.dates` array-contains-any) 중 변경 후 `target.teacherUids`에 내가 있는 차시의 수업. `teacherNames`(엑셀 이름)로는 찾지도 연결하지도 않습니다 — 이름만 같은 수업·이름만 바꾼 변경은 내 수업이 아님.
- 후보 수업의 반복 차시·변경을 `courseId in`으로 읽고(학기 범위·`selectOverridesForWindow`는 /me와 같음) 날짜마다 `computeTeacherOfficialDay`가 **학생 화면과 같은 엔진**(`buildDayTimetable`, 후보 수업을 수강처럼 넣음)으로 계산합니다. 엔진 수업 행의 `teacherUids`(변경 후 최종 담당)로 역할을 정합니다.
  - 기본 담당이 나이고 지금도 나: `mine`(변경 있으면 전후), 보강이면 `makeup`
  - 기본 담당이 나인데 변경으로 다른 교사: `changed-away`(빨강, 교사 변경 전후)
  - 기본 담당이 남인데 변경으로 나: `substitute`('대신 들어가는 수업', 남의 수업이라 상세 링크 없음)
  - 원래 내 차시의 취소·다른 날로 옮김·쉬는 날이라 열리지 않음 → `notices`(화면: 취소는 취소선 행, 옮김은 빨간 안내 줄)
  - 결과에는 다른 교사 uid·관리 교사 uid를 넣지 않음(이름만). 수강·학생 명단은 읽지 않음
- `hasOfficial`: **그 날짜에** 적용 중인(`seriesValidOn`, 요일 무관 — 주말도 공식 방식) 내가 기본 담당인 반복 차시가 있는 운영 중 수업이 있는지. 학기 중 다음 주부터 적용되는 차시는 시작 전 날짜에 세지 않고(그동안은 직접 등록 주간 시간표가 기본), 학기 중 모든 내 차시가 끝난 수업은 끝난 뒤 세지 않습니다.
- 교환(`school_swaps/{s}/requests`·`direct_requests`)·보결(`school_sos/{s}/requests`)은 학교 전체를 날짜로 읽지 않고 **내가 참여자인 문서만** 읽습니다: 참여자 필드마다 `uid ==` + `status ==`(교환 `'accepted'`, 보결 `'assigned'`) — 공개 요청 `requesterId`·`accepterId`, 1:1 요청 `requesterId`·`fromId`·`accepterId`·`toId`(예전 문서), 보결 `requesterId`·`assignedTo`. 같은 학교 다른 교사가 모집 중 요청을 많이 만들어도 내 교환·보결이 잘리지 않습니다(쿼리당 1000건 상한, 닿으면 로그). 날짜(조회 기간)는 메모리에서 거름. 교환 메모(`note`)·보결 사유(`reason`)·다른 교사 uid는 넣지 않고 이름(`requesterName`·`accepterName`·`assignedName`)만, 요청 교사 학급 '담임 없음'은 빈 값.
- 쿼리는 등호·`array-contains`·`array-contains-any`·`in`만(정렬·범위 없음) → 새 복합 인덱스·컬렉션 그룹 쿼리 없음(9절 표 그대로 — 등호 두 개는 단일 필드 인덱스 병합). 후보 수업 150개 상한.
- **쉬는 날**: 교사 수업은 여러 학년에 걸치므로 학생처럼 '내 학년'(users.grade) 하나로 정하지 않습니다(`teacherOffDaysFromRows`, `src/lib/neisOffDays.ts`). 학년 표시가 없는 행이나 그 날 쉬는 학년이 학교의 모든 학년(초 6, 중·고 3)을 덮으면 `offDays`(학교 전체 — 모든 수업이 열리지 않음), 일부 학년만이면 `gradeOffDays`. 일부 학년 쉬는 날에는 그 학년 수업만 쉬는 날로 계산합니다 — 공식 수업은 공통 수업 학급(`commonForHomerooms` '…_3_4' → 3학년)으로, 주간 시간표 칸은 학반 라벨('3-2 국어' → 3학년)로 학년을 알고, 학년을 모르는 수업(선택 과목·라벨 없는 칸)은 그대로 보입니다. 날짜·교시를 명시적으로 옮긴 차시는 학생 화면처럼 열립니다.
- 담임 학급 교시표: `users.classId`는 본인이 고칠 수 있는 값이라 형식(경로 조각 하나)·학교 코드 접두를 확인하고, `classes/{id}.teacherId`가 나이고 같은 학교 학급일 때만 그 `info/periodTimes`를 씁니다(아니면 학교 엑셀 교시표 → 학교급 기본).

**날짜별 화면(클라이언트, 순수 함수 `buildTeacherDay`)**

| 방식 | 조건 | 기본 목록 |
|---|---|---|
| 공식(`official`) | `days[D].hasOfficial` | 공식 수업 행(변경 배지·전후, 수업 상세 `/teacher/courses/{id}` 링크) + 취소 행. 예전 주간 시간표는 접힌 '내 주간 시간표(직접 등록·참고)'로만 |
| 주간 시간표(`legacy`) | 공식 없음 + `mySchedule` 있음 | 그 요일 칸(`'1-5 국어'` → 국어 · 1학년 5반), 라벨 '내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요', 배지 '직접 등록 · 수업 변경 미반영'. 변경으로 나에게 넘어온 공식 수업·보강도 함께. 일부 학년 쉬는 날에는 그 학년 칸을 빼고 안내 줄로 |
| 빈 상태(`empty`) | 둘 다 없음 | '아직 등록된 내 시간표가 없어요' + 수업 관리(`/teacher/courses`)·내 시간표 등록(`/teacher/my-schedule`) |

- 모든 방식에 교환·보결 겹치기: 내 교시를 남이 맡음 → 같은 교시 내 수업 행에 '○○ 선생님이 대신 들어가요 (품앗이|보결)'(다른 선생님에게 넘긴 차시·변경으로 내가 대신 들어가는 남의 수업 행에는 붙이지 않음. 그 교시 내 수업 행이 없으면 따로 행 — 단 쉬는 날·학기 밖·그 학년이 쉬는 날에는 만들지 않음), 내가 맡음 → '대신 들어가는 수업 · {학급} {과목} (○○ 선생님)' 행(쉬는 날에도 보임).
- 상태는 학생 화면과 같음: 학교 전체 쉬는 날(휴업일·공휴일·방학) `holiday`, 학기 밖 `outside-term`(주간 시간표도 숨김), 주말·수업 없는 날 `no-lessons`, 학사일정 확인 실패 안내. 일부 학년만 쉬는 날은 `holiday`가 아니라 열린 수업 + '{학년} 쉬는 날이에요(행사명)' 안내 + 열리지 않는 수업 안내 줄(모두 열리지 않으면 `no-lessons`). 빈 상태 교사의 쉬는 날·학기 밖은 그 상태 카드 하나만(등록 안내 카드는 교환·보결 행이 있는 날에만 덧붙임). 로딩은 스켈레톤, 오류는 '다시 시도'(빈 목록으로 위장하지 않음), 자료가 있는 채 실패하면 동기화 배너.
- 실시간 갱신(`useTeacherTimetable`, `src/lib/timetable/teacherHomeClient.ts`): `schools/{s}.scheduleRevision` 구독(교사 읽기 허용) — 공식 변경 발행이 새로 고침 없이 반영. 교환·보결·주간 시간표는 버전을 올리지 않으므로 화면 복귀·포커스(30초 지난 자료)·온라인 복구 때 다시 받음. 조회 창은 학생과 같은 `clientWindow`(앞 3일~뒤 13일). 로컬 캐시는 두지 않음.
- 화면 조각은 학생 컴포넌트를 재사용: `DayNav`, `LessonCard`(선택 값 `extraBadges`·`struck`·`href`·`metaPrefix`·`personalLabel`·`wrapTime`(좁은 칸에서 시각을 '~' 뒤 줄바꿈) — 주지 않으면 학생 모양 그대로), `TimetableStateCard`(`teacher-empty` 추가), `InfoLine`. 조합은 `src/components/timetable/TeacherTimetable.tsx`.
- 테스트: `tests/unit/teacher-home-official.test.ts`·`teacher-home-day.test.ts`·`teacher-home-offdays.test.ts`(순수 로직), `tests/api/sa5-teacher-timetable.test.mjs`(API), `tests/e2e/u6-teacher-home.e2e.mjs`(화면).

**주간 보기 — 내 시간표 화면 (`/teacher/timetable?view=week|day&date=YYYYMMDD`, 요구 R21)**

홈 카드는 하루씩만 보여 주므로, 선생님이 '내 시간표'를 누르면 그 주 전체를 요일 × 교시 표로 봅니다. API 계약은 그대로이고(새 필드 없음) 같은 응답을 그 주 7일로 받아 화면에서 펼칩니다.

- 들어오는 곳: 홈 카드 제목('오늘의 내 수업'·'내 수업')과 머리의 '주간 시간표 →'(보고 있는 날짜의 주 — `?view=week&date=그 날짜`), 대시보드 카드 '내 시간표 (주간)', 앱 바로가기(PWA `manifest.webmanifest` shortcuts) '내 시간표'(`/teacher/timetable?view=week` — 예전에는 편집 화면 `/teacher/my-schedule`로 가서 같은 이름의 새 화면과 어긋났음). 제목 링크는 글자를 그대로 두고(카드 이름 `aria-labelledby`) 설명 '주간 시간표 보기'(`aria-describedby`)와 꺾쇠로 어디로 가는지 알림. '우리 반 시간표 보기'(담임)는 그대로. 대시보드 카드는 이름을 바꾸지 않고 새로 둠 — '내 수업 및 교환'(`/teacher/my-schedule`)은 직접 등록 주간 시간표를 고치고 교환을 요청하는 편집 화면이라 보기 전용 주간 시간표와 역할이 다르고, 이름을 바꾸면 익숙한 입구(교환 요청)를 잃음. 설명만 '직접 등록 주간 시간표 고치기·수업 교환 요청'으로 구분.
- 화면: 탭 '주간'(기본)·'하루'(주소 `view`), 날짜는 주소 `date`(없거나 틀리면 오늘, 학교 시간대). 교사만 — 학생은 학생 홈, 교사가 아닌 계정은 대시보드로(`useTeacherProfile`, 다른 교사 화면과 같음). '오늘'은 화면에 붙은 뒤 정함(하이드레이션 안전).
- 자료: `useTeacherTimetable(uid, date, schoolCode, WEEK_WINDOW_POLICY)` — 조회 창을 그 주 월~일 7일로(`clientWindow.ts`의 `WindowPolicy`: 받을 기간 `fetch`·화면에 필요한 기간 `need`). 받은 자료가 그 주 7일을 모두 포함해야 표를 그림(`covered`). 홈 카드는 기본 `DAY_WINDOW_POLICY`(앞 3일~뒤 13일, 그 날짜만 필요)라 예전과 같음. 시간표 버전 구독·화면 복귀·포커스·온라인 복구 때 다시 받기도 같음. 두 탭이 같은 자료라 탭을 바꿔도 다시 받지 않고, 주를 빨리 넘기면 앞 요청 응답은 버림(요청 순번) — 다른 주 자료로 표를 그리지 않음. 받기 전은 스켈레톤, 자료 없이 실패하면 오류 카드(다시 시도·오프라인) — 빈 표로 보이지 않음, 자료가 있는 채 실패하면 동기화 배너.
- 순수 모델 `buildTeacherWeek(payload, 그 주 아무 날)` (`src/lib/timetable/teacherWeek.ts`): 날짜마다 홈 카드와 같은 `buildTeacherDay`로 그 날 방식(공식 / 직접 등록 / 빈 상태)을 정하고 요일 열 × 교시 행 칸으로 펼침.

| 항목 | 규칙 |
|---|---|
| 열 | 월~금은 늘. 토·일은 그 날 수업·교환·보결·안내(옮겨 감·쉬는 날이라 열리지 않음)가 있을 때만 |
| 교시 행 | 1 ~ 있는 교시 중 최대. 최소 6, 직접 등록 주간 시간표 열(월~금)이 있으면 최소 7(예전 시간표 7칸 고정) |
| 칸 | 그 날 행 순서 그대로 여러 수업 모두. 칸 둘째 줄 학급(`3-5`)·교실, 배지 두 개까지(전체 문구는 칸 이름·`title`·상세) |
| 교시 밖 | 교시가 없거나(명시 시각만) 1보다 작은 교시(0교시 보결 등)는 표 아래 '교시 밖' 줄의 그 날 칸 — 빠뜨리지 않음 |
| 변경 표시 | 하루 보기·학생 화면과 같은 기준: 변경(시간·날짜·교실·교사)·보강 빨간 테두리 + '변경'/'보강', 취소 취소선 + '취소', 대신 들어가는 수업 빨간 '대신'(남의 수업이라 상세 링크 없음), 다른 선생님에게 넘긴 내 수업 '→정대체'(누가 맡는지), 내가 맡은 교환·보결 '대신'(과목 없는 보결은 제목 '보결 수업', 교환 칸 과목이 있으면 그 과목 + '품앗이'), 내 교시를 남이 맡음 '→이름'. 칸 이름(접근성)에는 하루 보기 카드 배지와 같은 변경 문구를 모두 — 대신 들어가는 수업·넘긴 수업도 교실·시간 변경까지('교사 변경'만 '대신 들어가는 수업'·'○○ 선생님이 맡아요'가 이미 말해 뺌) |
| 옮긴 수업 | 새 날 칸에 그 수업('날짜 변경'), 원래 칸에 점선 빨강 '옮김 · → 목 5교시'(다른 주면 '→ 10/14(수) 2교시') |
| 쉬는 날 | 학교 전체 쉬는 날·학기 밖이고 보일 것이 없는 날은 열 전체가 상태('쉬는 날 · 한글날' / '학기 밖'). 일정이 있으면 열고 열 머리에 쉬는 날 이름, 쉬는 날이라 열리지 않는 내 수업은 회색 '쉬는 날'. 일부 학년만 쉬는 날은 열 머리 '3학년 쉼' + 표 아래 안내 줄 + 그 학년 수업·주간 시간표 칸 회색 |
| 직접 등록 | 주 전체가 직접 등록이면 표 위 '내가 등록한 주간 시간표예요 — 수업 변경은 반영되지 않아요' + '주간 시간표 고치기'(`/teacher/my-schedule`), 칸은 회색 점선. 공식 날과 섞인 주(공식 수업이 주 중간부터 등)는 날짜마다 하루 보기와 같은 규칙 + 직접 등록 열 머리 '직접 등록' + 안내. 주 방식·'직접 등록' 표시·최소 7교시는 열린 월~금 직접 등록 열로만 정함(`isLegacyColumn`) — 토·일 열은 그 날 방식이 직접 등록이어도 주간 시간표 칸이 없어(교환·보결뿐) 공식 주를 혼합 주로 만들지 않음. 모든 열이 쉬는 날·학기 밖인 주(방학)는 직접 등록 안내 없이 열 상태만 |
| 빈 상태 | 공식 수업·직접 등록이 모두 없고 보일 일정도 없으면 표 대신 '아직 등록된 내 시간표가 없어요'(수업 관리·내 시간표 등록). 교환·보결만 있으면 표 + 같은 안내. 시간표는 있는데 그 주 열린 날에 보일 수업이 없으면(시험 주·다음 주부터 시작 등 — `noLessons`) 표 아래 '이 주에는 내 수업이 없어요'(하루 보기 '이 날은 수업이 없어요'와 같은 뜻) |

- 주 계산: 월요일 시작(`weekStartOf`, 일요일은 앞 주), 주 이동은 요일 유지(`shiftWeek`), 라벨 '이번 주 / 지난주 / 다음 주 / N주 전·뒤'와 보이는 열 기간 '10월 5일 ~ 10월 9일'(해가 바뀌면 연도), 머리 '‹ 지난주 · 이번 주 · 다음 주 ›' + 날짜 선택. 주소 바꾸기(얕은 `router.replace`)는 비동기라 아직 반영되지 않은 마지막 목적지를 기억해(`pendingRef`) 그 사이의 클릭은 거기서 이어 계산 — '다음 주'를 빠르게 두 번 = 2주 뒤, '다음 주' 바로 뒤 '하루' = 옮긴 주의 하루(앞 이동을 잃지 않음). `WeekNav`는 지난주·다음 주를 날짜가 아니라 몇 주인지(`onShift(±1)`)로 넘김.
- 표(`TeacherWeekGrid.tsx`): `<table>`(열 머리 요일·날짜 — 누르면 그 날 하루 보기, 행 머리 교시), 칸 버튼 이름 '화 3교시 영어 B 3학년 5반 교실 (교실 변경)'. 오늘 열 강조('오늘'), 이번 주면 지금 교시(행 머리 점·칸 테두리). 칸을 누르면 상세 시트(하루 보기와 같은 수업 카드 `TeacherRowCard` — 공식 수업은 수업 상세 링크, 변경 전후·사유) + '이 날 전체 보기'(하루 탭). 시트는 연 칸(날짜·교시)만 기억하고 내용은 그릴 때마다 지금 모델에서 읽음 — 열어 둔 사이 변경이 와도(시간표 버전 구독·화면 복귀) 새 내용, 그 칸이 비거나 열이 닫히면 닫힘. 옮겨 감·쉬는 날 안내 줄도 내 공식 수업이면 '수업 상세' 링크. Esc·바깥·닫기로 닫고 연 칸으로 초점, Tab·Shift+Tab은 시트 안에서만 돎(`aria-modal`). 열 머리 버튼 이름 '화 10/6 오늘 하루 보기'(보이는 글자 + 할 일). 390px: 칸 최소 48px로 월~토 6열까지 화면 안, 7열이면 표 상자 안에서만 옆으로 밀림(교시 열 고정) — 화면 자체는 옆으로 밀리지 않음. 칸 버튼 높이 48px, 머리·탭·주 이동 버튼 44px 이상.
- 하루 탭과 홈 카드는 같은 하루 화면 조각(`TeacherDayBody.tsx` — `TeacherDayPanel`·`TeacherDayBody`·`TeacherRowCard`·`LegacyScheduleNote`)을 씀. 수업 표시 문구(`lessonTitle`·`changeBadgeLabels`·`lessonTimeRange`·`shortDateKo`)는 순수 모듈 `lessonText.ts`로 옮겨 주간 모델도 같은 문구(`LessonCard`가 다시 내보내 기존 import 그대로).
- 테스트: `tests/unit/teacher-week-dates.test.ts`(주 계산·라벨·주간 조회 창), `tests/unit/teacher-week-model.test.ts`(열·교시·칸·교시 밖·변경·옮김·직접 등록·혼합·쉬는 날·빈 상태), `tests/e2e/u8-teacher-week.e2e.mjs`(화면 — 연달아 누른 주 이동, 시트 Tab 순환·열어 둔 시트에 변경 반영, 토·일 7열 주의 표 상자 안 가로 밀림·교시 열 고정, 다른 주를 받지 못함(500·오프라인) → 오류 카드(빈 표 없음) → 다시 시도 포함).

## 11. 학생 수업 담기(골라 담기) (`/student/courses#catalog`, 요구 R20)

학생이 직접 입력(자유 입력)으로 시간표를 만들면 오타·다른 이름 때문에 선생님이 발행한 변경이 닿지 않습니다. 그래서 시간표를 만드는 **기본 방법은 학교가 공개한 공식 수업 목록에서 골라 담는 것**입니다. 담은 수업은 수강(`enrollments`)이 되어 변경이 자동 반영됩니다. 직접 입력은 학원·자습 같은 학교 밖 일정용으로 안내합니다. 이름으로 연결하는 일은 어디에도 없습니다(학생이 고른 수업만, 직접 입력 일정은 학생이 '연결'을 고를 때만).

**공개 목록(`/api/courses` `catalog`)** — 같은 학교 사용자. 이번 학기(`termForDate(오늘)`) + `catalogVisible == true` + 운영 중(`courseActiveOn`, 그리고 시간표 가져오기(바꾸기)가 정리한 수업 — `importRetiredOn ≤ 오늘`, 차시가 모두 끝난 빈 수업 — 제외: `importRetiredBy`) 수업만, 수업마다 제목·과목·분반·교사 이름·기본 교실·참여 방식(`invitePolicy`)·요일·교시·교실(`slots`, 오늘 이후 이어지는 차시)·본인 수강 상태(`myStatus`)·대상 학년(`grades`, 정한 수업만)·대상 반(`classLabels`, 정한 수업만)·**나에게 보이는 방식 `offer`**(`'mine'` 기본 보기 / `'other'` '다른 반·학년 수업도 보기'에서만). 응답에 `me {grade, classLabel}`(판정에 쓴 내 학년·반)과 `withheld`(보내지 않은 수 — 빈 화면 구분용). 수강 인원·명단·교사 uid 없음. 쿼리는 기존 (termId, catalogVisible) 인덱스 그대로.

**누구에게 보일지 — 대상 반·학년(서버에서 거름, 순수 함수 `courseOfferFor`·`offerCatalog` in `coursePicker.ts`)**. 학생의 반은 프로필 `users.grade`-`users.classNm`('2-1', `studentScopeOf` — 숫자·'4반'만, 모르면 null). **교사(`isTeacher`)만 거르지 않음** — 학생과 그 밖의 계정(역할 표시가 없는 예전 계정 등)은 모두 같은 규칙으로 거름(반을 모르면 반별 수업은 받지 않음).

**반별 수업인지 — 대상 반 개수가 아니라 출처로(`courseClassScope`)**. 칸이 한 반에서만 나온 선택·이동 수업이 있기 때문입니다: 영어 A/B 수준별 반은 이번 파일에 영어 A가 3-4 칸만, 영어 B가 3-5 칸만 있어도(`tests/fixtures/import/three-sources.json`) 3-5 학생이 영어 A에 배정될 수 있습니다. 개수로만 판정하면 그 학생은 영어 A를 찾지도 담지도 못합니다.

| 출처 | 반별 수업(`'homeroom'`) | 여러 반·선택·이동 수업(`'classes'`) |
|---|---|---|
| 교사가 수업 화면에서 정한 대상 반(`classLabelsBy:'teacher'`) | 한 반 | 둘 이상 — 교사 화면 안내('한 반만 적으면 그 반 학생에게만')와 같음 |
| 시간표 가져오기(`importKey`가 있는 수업, `classLabelsBy:'import'`) | **한 학급 수업 `hr\|2-1\|국어\|…`만** | 분반 `sec\|…`·수업 코드 `code\|…`·여러 학급 `mc\|…` — 칸이 한 반에서만 나와도 |
| 출처 표시가 없는 값(예전 자료) | 한 반 | 둘 이상 |

가져오기 키는 수업 id를 만드는 값이라 바뀌지 않고, 대상 반 출처(`classLabelsBy`)는 이미 가져오기·원복·교사 보호를 거치므로, 따로 저장하는 필드 없이 판정합니다(교사 화면 `get`/`list` 응답의 `classScope`도 같은 함수). 담당 교사가 분반 수업의 대상 반을 한 반으로 직접 정하면 그때는 반별 수업입니다.

| 수업(대상 반 `classLabels`·`courseClassScope`) | 내 반이 대상 반에 있음 | 같은 학년 다른 반 / 다른 학년 | 내 반을 모름 |
|---|---|---|---|
| **반별 수업** — 가져오기의 한 학급 수업(`hr\|2-1\|국어\|…`), 교사가 한 반만 정한 수업 | `mine` | **`never` — 보내지 않음**('다른 반·학년 수업도 보기'로도 안 보임), 담기 `other-class` | `never`(어느 반 수업인지 확인할 수 없음 — 소속 학급을 등록하면 보임, 화면이 안내) |
| **여러 반·선택·이동 수업** — 대상 반 둘 이상(이동·선택·합반, 교사가 여러 반을 정함), 또는 분반·수업 코드 수업(한 반 칸만 있어도) | `mine` | `other`(보기를 켜면 보이고 담을 수 있음) | 대상 반들의 학년에 내 학년이 있으면 `mine`, 아니면 `other`(학년도 모르면 `mine`) |
| **없음** — 예전 학년 규칙 | 대상 학년이 없거나 대상 학년에 내 학년이 있으면 `mine` | 대상 학년에 내 학년이 없으면 `other` | 학년만 알면 왼쪽과 같음, 내 학년도 모르면 `mine` |

- **왜 반별 수업은 보기를 켜도 안 보이나**: 같은 학년 2-2 국어는 2-2의 정규 수업이지 2-1 학생이 고를 선택지가 아닙니다. 보기를 켜서 담으면 남의 반 시간표(그 반 교사·교실·변경)가 내 시간표가 되고, 이름이 같은 '국어'가 반마다 있어 잘못 고르기 쉽습니다(이름으로 고르지 않는다는 원칙과 같은 이유). 그래서 서버가 목록에 넣지 않고(`withheld`로 개수만), `requestMany`·`request`도 같은 판정(`planRequest`)으로 거절합니다(403 `other-class`, 이미 참여·승인 대기면 그대로 `already`). 'never'는 반별 수업에만 씁니다 — 선택 과목·수준별 반처럼 반을 넘어 듣는 수업(대상 반 둘 이상, 또는 분반·수업 코드 수업은 대상 반이 하나여도)은 다른 반 학생도 보기로 찾아 담을 수 있습니다(`courseClassScope`). 한 반 수업을 다른 반에도 열고 싶으면 담당 교사가 '대상 반'에 반을 더하거나 비우면 됩니다.
- **내 수강은 언제나 내 것**: 본인 수강이 참여·승인 대기인 수업은 판정과 상관없이 `offer:'mine'`으로 보내고(선생님이 넣어 준 다른 반 수업, 반을 옮긴 학생), 화면도 내 시간표 자료(`myCourseStates`·칸의 내 수업·방금 담은 수업)에 있는 수업은 거르지 않습니다. 끝낸(뺀) 수강은 다시 판정합니다.
- 대상 반이 있으면 대상 학년보다 먼저 봅니다(교사가 정한 대상 학년이어도 — 대상 반을 바꾸거나 비우는 것은 '대상 반'으로).

**화면(`src/components/timetable/CoursePicker.tsx`, 계산은 순수 함수 `src/lib/timetable/coursePicker.ts`)**

- 보기 두 가지(같은 자료): **시간표 칸 보기**(기본) — 요일 × 교시 표(월~금, 토·일은 공개 수업이나 내 수업 차시가 있을 때만, 교시는 1교시부터 있는 교시 중 가장 큰 교시까지·0교시는 있을 때만). 칸에는 이미 내 시간표에 있는 수업(참여·시작 예정·승인 대기·반 공통 — `/api/timetable/me` 자료로 계산, `myLessonsFrom`)과 담은 수업·겹침·고를 수 있는 수 표시. 칸을 누르면(버튼 — `aria-label`에 요일·교시·내 수업·담은 수업·고를 수 있는 수, `aria-expanded`) 아래에 그 시간 수업 목록(제목·분반·선생님·교실·참여 방식·상태)이 열리고 거기서 '담기'. **과목으로 찾기** — 과목명 검색 목록(검색은 목록만 좁힘).
- 반·학년: 기본은 서버가 `offer:'mine'`이라고 한 수업(내 반·학년 수업, 반·학년 미상 수업) + 이미 내 것인 수업. '다른 반·학년 수업도 보기'로 받은 수업 전부(다른 반의 반별 수업은 받지 않아 여기에도 없음). 화면과 직접 입력 안내가 같은 순수 함수 `filterForStudent`를 씀. 요약 줄 '내 학년·반(2학년 1반) 수업 N개 · 다른 반·학년 수업 M개 숨김', 보기 체크는 숨긴 수업이 있을 때(또는 켜져 있을 때)만. 내 반을 몰라 반별 수업을 받지 못하면 '내 반 정보가 없어 반별 수업은 보이지 않아요 — 담임 선생님의 학급 초대로 소속 학급을 등록하면 보여요'.
- 빈 화면(`catalogEmptyState`, 칸 보기·과목으로 찾기 공통): 받은 수업도 보내지 않은 수업도 0 → '지금 학교에 공개된 수업이 없어요'(진짜로 공개 수업이 없음). 공개 수업은 있는데 지금 보기에 보이는 수업이 0 → '내 학년·반 수업이 아직 없어요' + (보기를 켜면 보이는 수업이 있으면) '다른 반·학년 수업도 보기' 버튼, 없으면(다른 반의 반별 수업뿐) 그 이유. 보이는 수업은 있는데 요일·교시가 없으면 칸 보기만 '요일·교시가 등록된 수업이 아직 없어요 — 과목으로 찾기에서'. 과목 검색이 비면 숨긴 수업 중 맞는 수('다른 반·학년 수업 중 N개가 맞아요')와 보기 버튼.
- 담은 수업(장바구니, 최대 20개): 섹션 아래에 붙어 따라오는 '담은 수업 N'(`sticky bottom-0`, 아래 여백 `max(0.75rem, env(safe-area-inset-bottom))` — iPhone 홈 표시줄에 가리지 않음). 막대가 보이는 동안 막대 높이만큼 문서 `scroll-padding-bottom`과 열린 칸 목록의 `scroll-margin-bottom`을 두어 키보드로 옮겨 간 칸·열린 칸 목록이 막대 뒤로 숨지 않음(사라지면 되돌림). 막대는 섹션 안 흐름이라 섹션 아래 내용을 덮지 않고, 이 화면에는 아래쪽 탭 막대가 없음. 겹침(같은 요일·교시) — 담은 수업끼리, 담은 수업과 이미 있는 내 수업(승인 대기·반 공통 포함) — 을 **경고로만** 보여 주고 그대로 담거나 뺄 수 있음(`cartConflicts`). '내 시간표에 담기' → 확인 시트(수업 이름·승인 필요 수·겹침 수) → `requestMany` **한 번** → 수업마다 '추가됨 / 선생님 승인 대기 / 이미 있음 / 담지 못함(이유)'(`mapRequestResults` — 응답에 없는 수업은 성공으로 보지 않음) → 내 시간표(`useMyTimetable().retry`)·목록 다시 받기. 요청 전체가 실패하면 장바구니를 그대로 두고 오류 code 안내.
- 빼기: '참여 중인 수업'과 칸 목록에서 **내가 담은 수업(출처 `request`, 참여·승인 대기)**만 '빼기'(승인 대기는 '신청 취소(빼기)'). 초대·명단·선생님 추가·예전 그룹 수강과 반 공통 수업은 버튼 없이 '선생님께 문의' 안내.
- 카드 상태(참여 중·승인 대기·다시 담기)와 '빼기'는 내 시간표 자료로 계산한 수업별 상태(`myCourseStates` — 차시가 아직 없는 수업·끝낸(뺀) 수강 포함)를 기준으로 합니다. 방금 담은 결과는 내 시간표 자료가 그 수업을 다시 알려 줄 때까지만 쓰고(그 뒤 빼거나 선생님이 거절하면 바로 '다시 담기'), 내 시간표 자료에 기록이 없는 수업만 목록 응답의 `myStatus`를 씀.
- 진입: 학생 홈 '내 수업'의 '+ 수업 담기'(수업이 없으면 빈 상태 안의 '수업 담기' 버튼), 상태 카드 '아직 연결된 수업이 없어요'의 첫 버튼(강조) '수업 담기', 내 수업 화면 빈 상태·바로가기. '초대 코드 입력'은 그대로.
- 390px: 칸 버튼은 44×44 이상(높이 56px, 너비는 표 최소 너비 `교시 열 1.5rem + 요일마다 44px + 칸 사이`로 보장). 월~금(5칸)·토 하나(6칸)는 그대로 들어가고, 토·일까지 7칸이면 표가 **자기 상자(`overflow-x:auto`) 안에서만** 옆으로 밀리고 교시 열은 고정(`sticky left-0`) — 화면(문서)은 옆으로 밀리지 않음(작은 화면 안내 '표를 옆으로 밀면 주말 칸이 보여요'). 글자는 말줄임. 로그인 확인 뒤에만 그려 하이드레이션 차이가 없음.
- 앵커(`#invite`·`#mine`·`#catalog`·`#personal`): 그 위 섹션들이 따로 늦게 채워지므로(참여 중인 수업·수업 담기 공개 목록·직접 입력) 셋이 각각 **처음** 자리를 잡을 때마다(두 프레임 뒤, 칸 표까지 그려진 다음) 그 섹션으로 다시 맞춤 — '다시 시도'로 다시 불러오는 것(불러오는 중 → 다 됨)은 다시 맞추지 않고(다시 시도를 누른 사람을 옮기지 않게), 사용자가 손대면(휠·터치·키·마우스 누름) 멈춤. 섹션 순서(참여 중인 수업 → 수업 담기 → 초대 코드 → 직접 입력)는 그대로: 시간표를 만드는 기본 방법이 수업 담기라 위에 두고, 초대 코드로 바로 가는 링크(`#invite`)는 이 다시 맞춤으로 정확히 도착함.

**학생 동작(`/api/enrollments`)**

| 동작 | 규칙 |
|---|---|
| `requestMany {courseIds}` | 학생만, 1~20개(21개 400 `too-many`, 문자열 아닌 항목 400). 중복 id는 한 번. 수업마다 `request`와 **같은 규칙**(`planRequest`): 요청자 학교 경로에서만 읽음(다른 학교 수업은 `course-not-found`), `catalogVisible`(아니면 `not-open`), 운영 중(`course-ended`), 이번 학기(`other-term`), 결정적 수강 id `courseId__uid`, 이미 active/pending이면 `already`(쓰기 없음). 운영 중에는 가져오기가 정리한 수업(`importRetiredOn ≤ 오늘`)이 아님도 포함(`course-ended`). `invitePolicy 'auto'` → active(오늘부터), 아니면 pending, 선생님이 끝내거나 거절한 수강은 다시 담으면 pending(`needsReapproval` — 그때 `reapproval:true`를 함께 써 두어, 학생이 그 승인 대기를 빼고 다시 담아도 pending. 선생님 `approve`·`add`가 지움. 초대 수락·그룹 QR도 같은 판정). 한 트랜잭션에서 수업·수강 문서를 모두 읽고 판정 → **일부 성공**, 바뀐 수강이 있으면 `scheduleRevision` +1 **한 번**·감사 로그 **한 건**(`enrollment.requestMany`, 수업 id와 상태 변화만). 예전 수업 그룹은 `extraClassIds` arrayUnion 한 번. 승인 대기 수업은 `request`와 같은 알림 id(`enr_{courseId}__{uid}_{오늘}`)로 담당·관리 교사에게 — 같은 날 다시 담거나 `request`로 신청해도 겹치지 않음. 응답 `{ ok, results:[{courseId, ok, status?, already?, code?, error?}], changed, revision }` |
| `leave {courseId}` | 학생만, 본인 수강 문서만(`courseId__내 uid`). 출처 `request`가 아니면 403 `not-self-picked`, 수강이 없으면 404, 이미 끝났으면 `already`. active → `ended`, `to = 오늘`(시작일이 뒤면 시작일 — 빈 기간): 오늘부터 빠지고 **지난 날짜 기록은 그대로**(엔진은 끝낸 수강을 [from, to) 동안 보여 줌). pending → `ended`, 기간 없음. `decidedBy`는 비워 두어 다시 담으면 처음처럼(바로 담기 수업은 바로) — 단 `reapproval`은 건드리지 않아 선생님이 끝낸 뒤 다시 신청한 수강은 계속 승인 대기. `leftBy`·`leftAt`·`leftOn`(오늘), `scheduleRevision` +1, 감사 `enrollment.leave`. **같은 수업은 하루 한 번**: 오늘 이미 뺀 수업을 다시 담았다가 또 빼면 429 `left-today`(담기·빼기 반복으로 학교 전체 갱신을 흔들지 못하게 — 수강 문서에 남는 오래가는 상한). 예전 그룹 톡방(`extraClassIds`)은 교사 `end`처럼 빼지 않음 |
| `request {courseId}` | 하나만 — 위와 같은 `planRequest`(이번에 '이번 학기' 확인이 공개 목록과 같아짐) |

수강 쓰기는 지금처럼 서버만(보안 규칙 변경 없음). 요청 수 제한은 학생이 담기·빼기를 반복해 학교 `scheduleRevision`을 계속 올려(같은 학교 학생 화면이 모두 다시 받음) 흔드는 것을 막는 상한입니다: uid별 10분 20회(묶음 담기는 한 번으로 셈)·빼기는 따로 1시간 10회(인스턴스 메모리 — best-effort, 세기 전에 확인해 정확히 그 횟수까지), 그리고 인스턴스와 무관하게 수강 문서의 `leftOn`으로 같은 수업 하루 한 번 빼기.

**빼고 다시 담아도 지난 날짜 그대로** — 수강 문서 id가 결정적(`courseId__uid`)이라 다시 담으면 `from`/`to`가 새 기간으로 바뀝니다. 이전 기간은 `history`에 남고, `enrollmentFromDoc`이 그중 들은 기간(끝낸 수강의 `[from, to)`, `to` 있고 `from < to` — 승인 대기에서 끝내거나 거절된 수강·같은 날 담았다 뺀 수강은 제외, 최근 20개)을 `past`로 꺼내 `/api/timetable/me`에 함께 보냅니다(본인 수강만). 엔진(`resolveCourses`)은 그 날짜가 `past` 기간 안이면 지금 상태(대기·끝남)와 상관없이 들은 수업으로 봅니다. 선생님이 끝낸 뒤 다시 신청한 경우도 같습니다.

**직접 입력 안내(`PersonalEntryForm`, 요일·교시로만)**

- 머리말: '학원·자습 같은 학교 밖 일정을 적어 두는 곳이에요. 학교 수업은 ‘수업 담기’에서 골라 담아야 …자동으로 반영돼요'.
- '이 시간 학교 수업': 고른 요일(특정 날짜면 그 날짜의 요일) + 교시, 또는 교시 없이 시각만 있으면 교시표에서 그 시각과 겹치는 학교 교시(`entrySchoolSlot` — 학원 18:00처럼 학교 교시 밖이면 없음). 그 칸에 열리는 공개 수업 중 아직 내 것이 아닌 수업은 '담기'(같은 담기 흐름 — 확인 시트 → `requestMany`, 결과 표시), 이미 듣는(연결 가능한) 수업은 기존 '연결'(학생이 고르면 연결 선택지만 바뀌고, 저장할 때 연결 확인). 입력한 제목은 이 계산에 들어가지 않음(`slotSuggestions`는 제목을 받지 않음). 담은 수업은 자료가 다시 오면 같은 칸의 '연결' 후보로 바뀜('방금 담았어요').
- 직접 입력 목록: 연결하지 않은 일정이 같은 요일·교시의 학교 수업(내 수업 또는 공개 수업)과 겹치면 '학교 수업과 시간이 겹쳐요 — 담기/연결하면 변경이 자동 반영돼요'(`entryOverlapsSchool`).
- 두 안내의 공개 수업은 수업 담기 기본 보기와 **같은 거르기**(`filterForStudent(…, false)`)를 거친 수업만 — 다른 반·학년 수업(`offer:'other'`)은 '담기' 후보가 아니고 그 수업 때문에 겹침 안내를 하지 않음(다른 반의 반별 수업은 애초에 받지 않음). 제목으로는 여전히 찾지 않음.

**학교가 목록을 채우는 방법** — 수업은 기본이 비공개(`catalogVisible:false`)라 이전에는 목록이 비어 있었습니다.

- 시간표 가져오기 확정 단계의 '학생 수업 담기 목록에 공개 (학생이 직접 골라 담기)'(기본 켬) + '바로 담기(기본) / 선생님 승인 후' → `commit.catalog {visible, policy}`. 적용 대상(`importManagesCatalog`·`importCatalogFor`): **새로 만드는 수업**과, **가져오기로 만든 기존 수업 중 공개 설정을 가져오기가 맡은 수업** — `catalogBy:'import'`이거나, 표시가 없는 예전 가져오기 수업 중 그때 기본값(비공개·승인 후) 그대로인 수업. 교사가 수업 화면에서 공개·참여 방식이나 예전 수업 그룹을 바꾼 수업(`catalogBy:'teacher'`, 또는 표시는 없지만 공개·바로 참여로 바뀌어 있는 예전 수업)과 **예전 수업 그룹(`legacyGroupId` — 톡방·공지)이 연결된 수업**(학생이 담으면 그 그룹에도 들어가므로 담당 교사만 공개를 정함)은 덮어쓰지 않습니다. 표시가 없던 예전 가져오기 수업은 '승인 후'를 교사가 일부러 골랐는지 알 수 없어 **공개 여부만 따르고 참여 방식은 '선생님 승인 후'로 둡니다**(`catalogBy:'import-legacy'` — 다음 가져오기도 바로 담기로 올리지 않음, 바로 담기는 담당 교사가 수업 화면에서). 가져오기는 학교 전체 작업이라 같은 학교 어느 교사의 발행이든 같은 규칙입니다. 끄고 발행하면 맡은 수업을 비공개로. `catalog`를 보내지 않은 호출(이전 화면·스크립트)은 예전처럼 새 수업 비공개·승인 후, 기존 수업 그대로. 원복하면 이전 값으로. 미리보기 비교 해시에는 넣지 않고 확정 때만 얹음(발행 교사·교사 연결 확인과 같은 방식).
- 가져오기는 수업마다 학급 표시를 대상 반 `classLabels`('3-4', 중복 없이 학년·반 순, `classLabelsBy:'import'`)로 기록합니다 — 한 학급 수업(`hr`)은 반별 수업이라 공개해도 그 반 학생에게만 보이고, 분반·수업 코드 수업은 칸이 한 반에서만 나와도 선택·이동 수업이라 다른 반 학생도 보기로 찾을 수 있습니다(`courseClassScope` — 위). 발행 규칙은 그대로: 반별 수업도 공개하고, 공개 목록이 반마다 거름. 학급 표시가 바뀌면 함께 바뀌고(변경 'labels'), 원복하면 이전 값. **교사가 수업 화면에서 정한 대상 반(`classLabelsBy:'teacher'`, 비운 값 포함)은 다시 가져와도 쓰지 않고 원복도 건드리지 않음**(가져오기 계획의 쓰기·원복 값에 넣지 않음 — `courseRestore`는 쓰는 선택 필드만 되돌림).
- 가져오기는 수업마다 학급 표시(`classLabels` '3-4')에서 대상 학년 `grades`(중복 없이 오름차순, `gradesFromClassLabels`)를 기록합니다. 학급 표시가 없는 수업(분반·코드 수업)은 `grades` 없음(학년 미상). 학급 표시가 바뀌면 함께 바뀜(변경 'grades', `gradesBy:'import'`). **교사가 수업 화면에서 정한 대상 학년(`gradesBy:'teacher'`, 비운 값 포함)은 다시 가져와도 덮어쓰거나 지우지 않음** — 학급 표시가 없는 분반·코드 수업에 교사가 학년을 정해 두는 경우를 지킴.
- 교사 수업 만들기·정보 수정: '대상 학년(선택)'(1~6 여러 개, `GradePicker`), '대상 반(선택)'(예: '2-1, 2-3' — 쉼표로 나눔, '2-1 2-3'처럼 반 표시만 띄어 써도 나눔(`splitClassLabelsText`), '2학년 1반'은 한 표시로. 한 반이면 그 반 학생에게만, 여러 반이면 그 반 학생에게 먼저, 비우면 대상 학년 규칙. `ClassLabelsInput`), 공개 체크 이름은 '학생 수업 담기 목록에 공개'. 상세에 '대상 반'과 판정(`classScope` — '이 반 학생에게만 보임 — 반별 수업' / '이 반 학생에게 먼저 보임 — 다른 반 학생도 찾아 담을 수 있음').
- 학급 시간표로 만든 공통 수업(`fromHomeroomTimetable`)과 마이그레이션이 만든 예전 수업은 계속 비공개(가져오기 대상이 아님).

**테스트**: `tests/unit/course-picker-grid.test.ts`·`course-picker-cart.test.ts`·`course-picker-entry.test.ts`(직접 입력 안내도 같은 거르기)·`course-picker-import.test.ts`(대상 반 출처·교사 값 보호·원복, `three-sources.json`의 한 반 칸만 있는 영어 A·B는 선택·이동 수업 — 3-5 학생에게 영어 A `other`)·`course-picker-history.test.ts`(순수 로직 — 이전 기간 past·다시 승인·정리된 수업)·`course-picker-audience.test.ts`(대상 반 성격 `courseClassScope`·대상 반·학년 판정·빈 화면 구분), `teacher-courses-ui.test.ts`(대상 반 입력 나누기), `tests/api/sa6-course-picker.test.mjs`(API — 2-1 학생은 2-2 국어를 받지도 담지도 못함, 2-1·2-3 선택 과목은 2-2에 offer other, 2-1 칸만 있는 분반 'A_영어'는 2-2·2-3에 offer other·담기 가능, 교사 `get`의 `classScope`, 역할 표시 없는 계정도 거른 목록), `tests/e2e/u7-course-picker.e2e.mjs`(화면 — 반별 국어는 보기를 켜도 다른 반 것이 안 보임, 7칸 44px·상자 안 가로 스크롤, 빈 화면 구분, 담은 수업 막대 여백), `tests/e2e/u2-student-courses.e2e.mjs`(`#invite` 앵커 — 공개 목록이 늦게 와도 초대 코드 섹션에 도착, 공개 목록 '다시 시도' 뒤에는 끌어가지 않음).
