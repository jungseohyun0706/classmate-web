# 기존 데이터 전환(마이그레이션)

스크립트: `scripts/migrate-timetable.mjs` — **운영 데이터에는 실행하지 않았습니다.** 운영 적용은 별도 승인 후에만 합니다.

## 1. 영향 조사 결과 (요약)

| 기존 데이터 | 개념 | 전환 |
|---|---|---|
| `classes/{학교_학년_반}` | 행정 학급(소속) | 그대로(소속 학급) |
| `classes/{학급}_g_{x}` (isGroup) | 행정 학급 × 교사 그룹 — 수업반·임시 소속이 섞인 혼합 개념 | 수업반 `schools/{s}/courses/lg_{groupId}`로 **연결만**(legacyGroupId). 과목·요일·교시가 없어 `needsReview`(담당 교사가 확인·차시 등록). 교사가 수업 반 목록에서 뺀 그룹은 전환하지 않고 보고만 |
| `users.extraClassIds` (그룹) | 그룹 톡방·명단 참여 | 그 그룹 수업의 수강(`source: legacy-group`). `extraClassIds`는 지우지 않음(톡방·공지 유지) |
| `users.classId`가 그룹인 학생 | 담임 미가입으로 그룹이 소속처럼 저장 | 그룹 수업 수강 + **소속은 바꾸지 않고 '소속 확인 필요'로 보고**(원본 반으로 추정하지 않음) |
| `classes/{id}/info/timetable` | 학급 시간표(학생 개인 수강과 다를 수 있음) | **자동 전환하지 않음**. 보고서에 학급 id와 담임 uid를 남기고, 담임이 교사 화면 '학급 시간표 → 공통 수업으로 연결'(`/api/courses` `fromHomeroomTimetable`)에서 직접 확인해야 공통 수업이 생김. 스크립트에는 이 전환 옵션이 없음(담임 확인을 대신하지 않도록 `--homeroom-common`은 거부) |
| `classes/{id}/overrides/{ymd}` | 교환 수락의 학급 단위 기록 | 옮기지 않음(학급 시간표 참고 보기에서 계속 사용). 개수만 보고 |
| 공지·알림장·톡방·알림 | `classes/{id}/...` | **변경 없음** — 대상 범위가 바뀌지 않음 |
| 초대 링크 `/join?c=&t=` | 10분 토큰 | 경로 유지(호환). 새 초대 코드 `/i/{code}` 추가 |

## 2. 실행 단계 (운영 배포 → 전환)

운영 프로젝트는 `classmate-mvp-9f855`입니다. 아래 순서대로 하고, 각 단계가 끝난 것을 확인한 뒤 다음 단계로 넘어갑니다. 0)~4)는 저장소 루트에서 실행합니다. 3)과 4)는 사용자가 적은 시간(야간·주말)에 이어서 합니다(이유는 3절).

| 단계 | 하는 일 | 다음으로 넘어가는 조건 |
|---|---|---|
| 0) 백업 | Firestore 관리형 내보내기 | 내보내기 성공 |
| 1) 인덱스 비교 | 운영 인덱스와 `firestore.indexes.json` 비교 | 운영에만 있는 인덱스를 적어 둠 |
| 2) 인덱스 배포 | `firebase deploy --only firestore:indexes` | 새 복합 인덱스가 모두 READY |
| 3) 규칙 배포 | `firebase deploy --only firestore:rules` | 배포 완료 → **바로** 4) |
| 4) 앱 배포 | `vercel --prod` | classmate.kr에서 교사·학생 화면 확인 |
| 5) 전환 dry-run | 읽기만, 보고서 생성 | 보고서 검토 |
| 6) 전환 적용 | `--apply --confirm-production` | **별도 승인 후에만** |
| 7) 교사 후속 작업 | 교사 화면에서 확인·차시 등록 | 아래 목록 |

```bash
# 0) 백업: Firestore 관리형 내보내기(명령은 내보내기가 끝날 때까지 기다림). BACKUP_BUCKET은 운영 백업용 Cloud Storage 버킷
BACKUP_BUCKET=gs://<운영 백업 버킷>
gcloud firestore export "$BACKUP_BUCKET/before-timetable-$(date +%Y%m%d-%H%M)" --project classmate-mvp-9f855

# 1) 운영 인덱스 확인 → firestore.indexes.json과 비교. 운영에만 있는 인덱스(콘솔에서 만든 것,
#    예: classes (schoolCode, grade, classNm) — 교사 '전체 시간표'(teacher/view-timetables)가 씀)를 적어 둡니다.
firebase firestore:indexes --project classmate-mvp-9f855

# 2) 인덱스 먼저(추가만 하고 앱 동작은 바꾸지 않음). 파일에 없는 인덱스를 지울지 물으면 반드시 No. --force 금지
firebase deploy --only firestore:indexes --project classmate-mvp-9f855
#    → 새 복합 인덱스가 모두 READY가 될 때까지 기다립니다(콘솔 Firestore > 색인에 '빌드 중' 없음, 또는 아래 STATE가 모두 READY).
#      특히 changeSets (affectedCourseIds 배열 포함, createdAt 내림차순) — 없으면 수업별 변경 기록이 500 index-required
gcloud firestore indexes composite list --project classmate-mvp-9f855

# 3) 규칙
firebase deploy --only firestore:rules --project classmate-mvp-9f855

# 4) 앱 — 3) 바로 다음에(몇 분 안에)
vercel --prod
#    → classmate.kr에서 교사 1명·학생 1명으로 로그인해 오늘 화면, 교사 '수업 관리', 학생 '직접 입력' 목록이 오류 없이 열리는지 확인
```

전환 스크립트(5)~6))의 자격 증명과 작업 폴더:

```bash
# 이 스크립트는 앱의 .env(FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_JSON_PATH)를 읽지 않고
# Application Default Credentials(ADC)를 씁니다. firebase login·gcloud auth login 만으로는 ADC가 생기지 않습니다.
# (권장) 운영 Firestore 읽기·쓰기 권한(예: Cloud Datastore 사용자 역할)이 있는 계정으로:
gcloud auth application-default login
# 이어서 할당량 프로젝트 지정 — 없으면 Firestore가 최종 사용자 자격 증명을 'end user credentials ... not supported'
# (PERMISSION_DENIED)로 거부할 수 있습니다(gcloud 기본 프로젝트가 없거나 다른 프로젝트일 때).
gcloud auth application-default set-quota-project classmate-mvp-9f855
# (또는) 서비스 계정 키 파일 — 반드시 저장소 밖에 두고(저장소 안이면 스크립트가 경고) 작업이 끝나면 지웁니다:
#   export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/classmate/classmate-mvp-9f855-migration.json"

# 보고서·실행 로그에는 학생 uid가 든 문서 경로가 있어 저장소 밖 작업 폴더에서 실행합니다(저장소 루트에서 시작).
REPO="$PWD"
mkdir -p ~/classmate-migration && cd ~/classmate-migration
```

```bash
# 5) dry-run(읽기만, 보고서 파일 생성)
node "$REPO/scripts/migrate-timetable.mjs" --project classmate-mvp-9f855
#    → migration-dryrun-<runId>.json : 만들 수업 수, 수강 수, 이미 전환된 수, 교사가 목록에서 뺀 그룹(issues의
#      group-not-in-teacher-list — 전환하지 않음), 소속 확인 필요 학생, 공통 수업 미지정 학급, 예전 변경 일수, 쓸 문서 경로

# 6) 적용 — dry-run 보고서를 검토하고 승인받은 뒤에만
node "$REPO/scripts/migrate-timetable.mjs" --project classmate-mvp-9f855 --apply --confirm-production classmate-mvp-9f855
#    → migration-log-<runId>.json : 쓴 문서 경로(배치마다 커밋 전에 기록), committedWrites(커밋이 끝난 수), done
#    중간에 실패하면 같은 명령을 다시 실행합니다. 결정적 id(lg_{groupId}, {courseId}__{uid})라 중복 생성은 없지만
#    실행마다 runId와 로그 파일이 새로 생깁니다(되돌릴 때는 로그를 모두 함께 — 아래).

# 복구(필요할 때만) — 이 폴더의 실행 로그를 모두 한 번에 줍니다. 몇 번 나눠 실행했어도 한 명령이고, 다시 실행해도 안전합니다.
node "$REPO/scripts/migrate-timetable.mjs" --project classmate-mvp-9f855 --confirm-production classmate-mvp-9f855 --rollback migration-log-*.json
```

- **복구가 지우는 것**: 주어진 로그의 실행이 만들고 이후 아무도 고치지 않은 문서만 지웁니다. 수업(`lg_`)마다 먼저 남길지 정합니다. 이후 수정됐거나(`modified`, 다른 실행이 다시 만든 것은 `other-run`) 그 뒤 생긴 차시·변경·수강·명단·변경 묶음·초대가 가리키면 수업을 남기고 `skippedCourses`로 보고합니다. 이때 그 수업의 수강도 지우지 않습니다(`keptEnrollments`, 학생 uid는 보고하지 않음). 지우면 원래 그룹 학생의 시간표에서 그 수업이 사라지기 때문입니다. 남은 수업은 담당 교사가 정리합니다('수업 끝내기'). 지운 문서가 있는 학교는 `scheduleRevision` +1.
- **수업은 주지 않은 로그에 있을 때**: 예를 들어 그룹에 학생이 늘어 5)~6)을 다시 실행한 실행만 되돌리면, 그 로그에는 새 수강만 있고 수업은 앞 실행 로그에 있습니다. 이때 수업은 지우지 않습니다. 같은 기준으로 남는 수업이면(이후 수정됐거나 차시·다른 수강 등이 가리킴) 그 수강도 남기고 `skippedCourses`에 `not-in-logs`로 보고합니다. 수업이 없거나 이 로그의 수강 말고 가리키는 것이 없을 때만 수강을 지웁니다.
- **로그가 여러 개일 때**: 수업은 앞 실행 로그에, 그 수업의 수강 일부는 다음 실행 로그에 있을 수 있습니다. 로그를 하나만 주면 다른 로그가 만든 수강 때문에 수업이 남습니다. 그래서 위처럼 `migration-log-*.json`을 한 번에 줍니다. 하나만 주면 스크립트가 같은 폴더의 다른 로그를 `notIncludedLogs`와 경고로 알려 줍니다. 다른 프로젝트의 로그는 거부합니다.
- **`--school <학교 코드>`**: dry-run·적용은 그 학교만, 복구는 로그 중 그 학교 문서만 처리합니다. 값이 비었거나(빈 셸 변수 등) 바로 다음 옵션이 오거나 모르는 인자가 있으면 실행하지 않습니다(전체 학교로 넓어지지 않음). 복구할 때 로그에 그 학교가 없으면 거부합니다.
- **운영 쓰기 확인**: 적용과 복구 모두 `--confirm-production <같은 project id>`가 없으면 아무것도 쓰지 않고 끝납니다(종료 코드 2). 에뮬레이터는 `FIRESTORE_EMULATOR_HOST`만 있으면 되고 자격 증명이 필요 없습니다.
- **자격 증명 오류**: `Could not load the default credentials`, `PERMISSION_DENIED`(할당량 프로젝트가 없을 때의 `end user credentials ... not supported` 포함)가 나면 스크립트가 위 설정 방법을 다시 알려 줍니다. 자격 증명이 없으면 첫 읽기에서 멈추므로 아무것도 쓰지 않습니다. `GOOGLE_APPLICATION_CREDENTIALS`가 없는 파일을 가리키면 시작 전에 거부합니다.
- **교사가 목록에서 뺀 그룹**: 예전 '목록에서 빼기'는 교사 `users.teachingClassIds`에서만 지우고 그룹 문서와 학생 `extraClassIds`는 남겼습니다. 담당 교사 목록에 없는 그룹과 교사 계정이 없는 그룹은 수업·수강을 만들지 않고 `issues`(`group-not-in-teacher-list`, `removed-from-list`·`teacher-missing`)로 보고만 합니다. 교사가 수업 반 목록에 다시 넣으면 다음 실행 때 전환됩니다.
- **지난 학기 그룹**: 예전 그룹에는 학기 정보가 없어 지난 학기 그룹을 따로 가려낼 수 없습니다. 교사 목록에 남은 그룹은 오늘이 속한 학기의 수업(`needsReview`)으로 만들어지므로 7)에서 담당 교사가 확인합니다. 지난 학년도 학생이 그룹에 남아 있으면 교사가 명단에서 정리합니다.
- 학기: `schools/{s}/terms`에서 오늘을 포함하는 문서, 없으면 기본 규칙(1학기 3/1~8/16, 2학기 8/16~다음 해 3/1).

7) 교사 후속 작업(적용 뒤):

- 담당 교사: '수업 관리'에서 '예전 수업 그룹에서 옮김' 수업(검토 필요)을 열어 과목명·요일·교시(차시)를 등록하고 명단을 확인합니다. 더 이상 하지 않는 수업이면 '수업 끝내기'를 누릅니다. 차시를 등록하기 전에는 학생 시간표에 '수업은 연결됐지만 선생님이 아직 시간표를 등록하지 않았어요'로만 보입니다.
- 담임: 보고서 `unclassified`의 `homeroom-timetable-not-common` 학급은 담임이 '수업 관리 → 학급 시간표 → 우리 반 공통 수업으로 연결'에서 확인해야 공통 수업이 생깁니다.
- 소속 확인 필요(`group-as-homeroom`) 학생: 그룹이 소속처럼 저장된 학생입니다. 담임·교사가 실제 소속 학급을 확인합니다.
- 전환하지 않은 그룹(`group-not-in-teacher-list`): 필요하면 교사가 수업 반 목록에 다시 넣은 뒤 5)~6)을 다시 실행하거나, 새 수업을 만들어 초대합니다.

## 3. 호환성

### 규칙을 앱보다 먼저 배포하는 이유

앱을 먼저 배포하면 '새 앱 + 예전 규칙' 기간이 생깁니다.

- **보안 틈**: 예전 규칙은 학생이 자기 `studentId`·`joinSeq`를 바꾸는 것을 막지 않고, 같은 학교 사용자가 알림 문서를 아무 id로나 만들 수 있게 둡니다. 새 서버는 정해진 id(`join_…`, `schedreq_no_…` 등)의 알림 문서가 이미 있으면 '이미 보냄'으로 보고 건너뜁니다. 그래서 이 기간에 미리 만들어 둔 문서로 신청·승인 알림과 푸시를 막을 수 있고, 이때 써 둔 값과 문서는 규칙을 배포한 뒤에도 남습니다.
- **새 기능 깨짐**: 예전 규칙에는 `schools/**`·`users/{uid}/personalEntries` 경로가 없어 모두 거부됩니다. 교사 '시간표 변경' 화면은 수업마다 오류가 나고, '수업 관리'의 공통 수업 후보도 오류가 납니다. 학생은 '직접 입력한 일정을 불러오지 못했어요'가 보이고, 저장하면 '다시 로그인해 주세요'라는 잘못된 안내가 나옵니다. 학생 화면 실시간 갱신도 끊깁니다. 직접 입력 구독은 오류 뒤 다시 붙지 않아, 규칙을 배포한 뒤에도 그 화면을 새로 열 때까지 남습니다.
- **인덱스**: 수업별 변경 기록 조회는 changeSets 복합 인덱스가 READY가 되기 전에는 500 `index-required`입니다. `firebase deploy`는 인덱스 빌드를 기다리지 않으므로 인덱스는 앱보다 먼저 배포하고 READY를 확인합니다.

반대로 '예전 앱(b7d6c46) + 새 규칙'은 안전합니다. 새 규칙은 새 경로를 더하고, 예전 앱이 쓰지 않는 필드만 조입니다(예전 앱의 알림은 `addDoc` 자동 id 20자, `studentId`·`joinSeq`·권한 필드는 서버만 씀).

### 주의: 운영 앱이 b7d6c46보다 오래됐을 때

- 예: 이번 작업 전 기준점 `665687a`. 그 앱은 교환·품앗이 수락과 보결 SOS '맡기'에서 슬롯 잠금 문서를 쓰지 않고, 새 교사의 학교·학급 등록을 클라이언트가 직접 씁니다. 새 규칙은 이를 거부하므로 3)과 4) 사이에는 이 흐름들이 권한 오류('Missing or insufficient permissions')로 실패합니다. 요청은 대기 상태로 남고 데이터는 깨지지 않으며, 새 앱에서 다시 하면 됩니다.
- 그래서 3)→4) 간격은 몇 분 안으로 줄이고, 사용자가 적은 시간에 합니다. 시작 전에 Vercel 배포 기록에서 운영 앱이 어느 커밋인지 확인해 둡니다.
- 4) 전에 열어 둔 탭과 설치 앱(PWA)은 새로고침(앱 다시 열기) 전까지 예전 코드라 같은 흐름이 실패할 수 있습니다. 새로고침하면 됩니다.
- 이 규칙이 배포된 동안에는 앱을 b7d6c46보다 오래된 버전으로 되돌리지 않습니다. 앱을 되돌려야 하면 그 버전에 맞는 `firestore.rules`도 함께 배포합니다.

### Preview 배포도 운영 Firebase를 씀

- GitHub 연결로 만들어지는 Vercel Preview 빌드도 같은 운영 Firebase 프로젝트(`classmate-mvp-9f855`)를 씁니다(환경 변수를 모든 환경에 넣었을 때의 Vercel 기본값). 3) 전에는 Preview의 새 화면이 예전 규칙에 막히고, 3) 뒤에는 운영 데이터를 그대로 읽고 씁니다.
- Preview 주소에서 시간표 가져오기 확정, 수강 명단 확정·연결, 시간표 변경 발행처럼 서버(firebase-admin)가 쓰는 작업을 하면 운영 `schools/{학교}/...`에 실제 문서가 생기고 운영 학생 화면의 `scheduleRevision`이 올라갑니다. Preview에서는 이런 작업을 하지 않거나, Vercel에서 `FIREBASE_SERVICE_ACCOUNT_JSON`을 Production 전용으로 둡니다.

### 첫날 학생·교사가 보는 것

- 학생: 전환 직후에는 연결된 공식 수업에 차시가 없습니다(공통 수업은 담임 확인 전, 그룹 수업은 차시 등록 전). 그래서 오늘 화면과 시간표에 '학급 시간표(참고) — 내 수업과 다를 수 있어요'가 처음부터 펼쳐져 예전처럼 학급 시간표를 볼 수 있습니다. 개인 시간표(내 수업)는 교사가 수업을 연결하거나 만든 뒤부터 채워집니다. 담임의 공통 수업 연결, 담당 교사의 그룹 수업 차시 등록, 새 수업 초대·수강 명단이 여기에 해당합니다.
- 전환된 그룹 수업은 학생 '내 수업' 목록에 출처 '예전 수업 그룹'으로 보입니다. 차시를 등록하기 전에는 시간표에 수업이 나오지 않습니다.
- 혼합 버전 기간: 예전 화면은 `classes`·`users.classId`·`extraClassIds`만 읽고, 새 화면은 `schools/{s}/...`를 추가로 읽습니다. 전환은 새 문서만 만들고 기존 필드를 지우지 않아 톡방·공지·알림장 등 예전 화면이 깨지지 않습니다.

## 4. 검증 (T41)

로컬 에뮬레이터 fixture에서 dry-run → 적용 → 중단 후 재실행 → 복구를 실행합니다(`tests/e2e/migration.test.mjs`). 결과는 `docs/classmate-timetable-qa.md`.

인자 검사(`--school` 빈 값, 운영 복구의 `--confirm-production`, 자격 증명 파일·할당량 프로젝트 안내), 목록에서 뺀 그룹 제외, 남기는 수업의 수강 보존(수업이 주지 않은 로그에 있을 때 포함), 여러 로그 한 번에 복구는 에뮬레이터 없이 `npm run test:unit`(`tests/unit/prod-b-migrate-script.test.ts`, 가짜 firebase-admin)으로도 확인합니다.
