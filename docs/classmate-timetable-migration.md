# 기존 데이터 전환(마이그레이션)

스크립트: `scripts/migrate-timetable.mjs` — **운영 데이터에는 실행하지 않았습니다.** 운영 적용은 별도 승인 후에만 합니다.

## 1. 영향 조사 결과 (요약)

| 기존 데이터 | 개념 | 전환 |
|---|---|---|
| `classes/{학교_학년_반}` | 행정 학급(소속) | 그대로(소속 학급) |
| `classes/{학급}_g_{x}` (isGroup) | 행정 학급 × 교사 그룹 — 수업반·임시 소속이 섞인 혼합 개념 | 수업반 `schools/{s}/courses/lg_{groupId}`로 **연결만**(legacyGroupId). 과목·요일·교시가 없어 `needsReview`(담당 교사가 확인·차시 등록) |
| `users.extraClassIds` (그룹) | 그룹 톡방·명단 참여 | 그 그룹 수업의 수강(`source: legacy-group`). `extraClassIds`는 지우지 않음(톡방·공지 유지) |
| `users.classId`가 그룹인 학생 | 담임 미가입으로 그룹이 소속처럼 저장 | 그룹 수업 수강 + **소속은 바꾸지 않고 '소속 확인 필요'로 보고**(원본 반으로 추정하지 않음) |
| `classes/{id}/info/timetable` | 학급 시간표(학생 개인 수강과 다를 수 있음) | **자동 전환하지 않음**. 보고서에 학급 id와 담임 uid를 남기고, 담임이 교사 화면 '학급 시간표 → 공통 수업으로 연결'(`/api/courses` `fromHomeroomTimetable`)에서 직접 확인해야 공통 수업이 생김. 스크립트에는 이 전환 옵션이 없음(담임 확인을 대신하지 않도록 `--homeroom-common`은 거부) |
| `classes/{id}/overrides/{ymd}` | 교환 수락의 학급 단위 기록 | 옮기지 않음(학급 시간표 참고 보기에서 계속 사용). 개수만 보고 |
| 공지·알림장·톡방·알림 | `classes/{id}/...` | **변경 없음** — 대상 범위가 바뀌지 않음 |
| 초대 링크 `/join?c=&t=` | 10분 토큰 | 경로 유지(호환). 새 초대 코드 `/i/{code}` 추가 |

## 2. 실행 단계

```bash
# 0) 백업: 운영이면 먼저 Firestore 관리형 내보내기(gcloud firestore export)로 스냅숏을 남깁니다.
# 1) dry-run (읽기만, 보고서 파일 생성)
node scripts/migrate-timetable.mjs --project <id>
#    → migration-dryrun-<runId>.json : 만들 수업 수, 수강 수, 이미 전환된 수, 소속 확인 필요 학생, 공통 수업 미지정 학급, 예전 변경 일수, 쓸 문서 경로
# 2) 적용 (에뮬레이터는 --apply만, 운영은 --confirm-production <같은 id> 추가 — 승인 후에만)
node scripts/migrate-timetable.mjs --project <id> --apply
#    → migration-log-<runId>.json : 쓴 문서 경로(배치마다 기록 → 중간 실패 지점 확인)
# 3) 재실행: 결정적 id(lg_{groupId}, {courseId}__{uid})라 다시 실행해도 중복 생성 없음
# 4) 복구: 이 실행이 만든 문서 중 이후 수정되지 않은 것만 삭제. 수업(lg_)은 이후 다른 자료(차시·변경·수강·명단·변경 묶음·초대)가 가리키면 남기고 skippedCourses로 보고. 지운 학교는 scheduleRevision +1
node scripts/migrate-timetable.mjs --project <id> --rollback migration-log-<runId>.json
```

옵션: `--school <schoolCode>`(한 학교만). 학기는 `schools/{s}/terms`에서 오늘을 포함하는 문서, 없으면 기본 규칙(1학기 3/1~8/16, 2학기 8/16~다음 해 3/1).

## 3. 호환성

- 혼합 버전 기간: 예전 화면은 `classes`·`users.classId`·`extraClassIds`만 읽고, 새 화면은 `schools/{s}/...`를 추가로 읽습니다. 전환은 새 문서만 만들고 기존 필드를 지우지 않아 예전 화면이 깨지지 않습니다.
- 새 규칙 배포 순서: 앱(서버 API) → 규칙·인덱스(`firebase deploy --only firestore`) → dry-run → 승인 → 적용.

## 4. 검증 (T41)

로컬 에뮬레이터 fixture에서 dry-run → 적용 → 중단 후 재실행 → 복구를 실행합니다(`tests/e2e/migration.test.mjs`). 결과는 `docs/classmate-timetable-qa.md`.
