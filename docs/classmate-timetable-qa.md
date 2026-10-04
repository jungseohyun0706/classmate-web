# 개인 시간표 개편 — 검증 기록 (R01–R18, T01–T46)

모든 실행은 **로컬 에뮬레이터**(Firestore·Auth, 프로젝트 `demo-classmate`)와 **로컬 Next 프로덕션 빌드**(`next build` + `next start`, NEIS는 `tests/support/neis-mock.cjs` 가짜 응답), **Chromium(Playwright, 390px)**에서 했습니다. 운영 데이터·운영 프로젝트·실기기·스토어·실제 FCM 푸시는 쓰지 않았습니다. 모든 데이터는 테스트용 가상 데이터입니다.

## 1. 실행 방법

```bash
# 단위(순수 엔진·가져오기 매칭)
npm run test:unit
# 에뮬레이터(프록시 변수 없이 — 규칙 파일 변경 시 다시 읽기가 실패해 종료되지 않게)
env -u HTTPS_PROXY -u https_proxy firebase emulators:start --only auth,firestore --project demo-classmate
# 보안 규칙
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node --test tests/rules/
# 로컬 E2E 빌드(가짜 Firebase 설정 + 에뮬레이터 연결 — src/lib/firebase.ts의 로컬 전용 연결 코드 필요, 커밋하지 않음)
NEXT_PUBLIC_USE_EMULATORS=1 NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-classmate … npx next build
# 서버(NEIS 가짜 응답). firebase-admin은 서비스 계정 형식의 설정이 있어야 켜지므로 에뮬레이터용 가짜 JSON
# (project_id demo-classmate, 임의 생성한 키 — 실제 키 아님, 저장소에 넣지 않음)을 FIREBASE_SERVICE_ACCOUNT_JSON으로 넘깁니다.
FIRESTORE_EMULATOR_HOST=… FIREBASE_AUTH_EMULATOR_HOST=… FIREBASE_SERVICE_ACCOUNT_JSON="$(cat 가짜-sa.json)" NODE_OPTIONS="--require tests/support/neis-mock.cjs" NEIS_MOCK_FILE=tests/fixtures/neis-mock.runtime.json npx next start -p 3100
# API 통합·E2E (각 파일이 에뮬레이터 데이터를 지우고 시드함 — 하나씩 차례로)
node tests/api/sa1-student-courses.test.mjs   # 수업·수강·개인 시간표 자료
node tests/api/sa2-schedule-changes.test.mjs  # 변경 발행
node tests/api/sa3-invitations.test.mjs       # 초대·/join
node tests/api/sa4-rules.test.mjs             # 규칙(서버 경유)
node tests/api/im1-import.test.mjs            # 시간표 가져오기
node tests/api/im2-roster.test.mjs            # 수강 명단
node tests/api/sa5-teacher-timetable.test.mjs # 교사 내 시간표
node tests/api/sa6-course-picker.test.mjs     # 학생 수업 담기
node tests/e2e/migration.test.mjs             # 데이터 전환(T41)
node tests/e2e/r01-verify.mjs                 # R01 해결 확인
node tests/e2e/u1-student-home.e2e.mjs        # 학생 홈·개인 시간표
node tests/e2e/u2-student-courses.e2e.mjs     # 학생 내 수업·직접 입력
node tests/e2e/u3-invite-install.e2e.mjs      # 초대·로그인 복구·설치 안내
node tests/e2e/u4-teacher-courses.e2e.mjs     # 교사 수업 관리·초대
node tests/e2e/u5-schedule-changes.e2e.mjs    # 교사 시간표 변경
node tests/e2e/u6-teacher-home.e2e.mjs        # 교사 메인 '오늘의 내 수업'
node tests/e2e/u7-course-picker.e2e.mjs       # 학생 수업 담기(가짜 xlsx 환경은 webpack 빌드 + XLSX_FULL_JS)
node tests/e2e/u8-teacher-week.e2e.mjs        # 교사 내 시간표 주간 보기
node tests/e2e/regression.e2e.mjs             # 기존 기능 회귀(F1–F13)
```

NEIS 서버 메모리 캐시(6시간) 때문에 E2E 파일마다 서버를 새로 띄우는 것을 권장합니다. 결과와 화면 캡처는 `tests/e2e/out-*/`(git 제외)에 남습니다.

## 2. 실행 결과

결과 표는 최종 실행 뒤 아래 7절에 적습니다(실행하지 않은 항목은 '미실행'으로 표시).

## 3. R01 원인과 확인

| 단계 | 내용 | 근거 |
|---|---|---|
| 재현(수정 전 `665687a`) | 학급 QR 학생: 급식은 보이고 "오늘 시간표 정보가 없어요" — 서버가 고등학교에도 초등 시간표 API(`elsTimetable`)를 불렀음 | `tests/e2e/r01-repro.mjs` (out-r01-baseline) |
| 재현(개편 전 HEAD `b7d6c46`) | 학급 QR 학생은 해결됐지만, 수업 그룹 QR 학생은 그룹이 '소속'처럼 저장되고 학년·반이 없어 시간표 원본이 없음. NEIS 실패·권한 오류도 "시간표 없음"으로 보임. 승인 전 학생이 그룹 QR을 찍으면 학급 신청이 덮어써짐(H2) | 같은 스크립트(out-r01-head) |
| 해결 확인(개편 후) | 학급 시간표를 개인 시간표로 대신 쓰지 않고 '학급 시간표(참고)'로 분리. 그룹 → 수업 전환(마이그레이션) + 담당 교사 차시 등록 → 개인 시간표 표시. 연결된 그룹 QR 새 학생은 바로 수강. 담임의 공통 수업 확인 → 반 학생 개인 시간표. NEIS 장애에도 개인 시간표 유지. H2 수정 | `tests/e2e/r01-verify.mjs` |

## 4. 요구사항(R) → 구현·검증

| R | 구현 | 검증 |
|---|---|---|
| R01 | 수업반·수강·개인 시간표, 그룹 QR 연결 수업 수강, 오류 구분 | r01-verify, u1 T01, sa3 R01 |
| R02 | `/install`, 랜딩 설치 안내·초대 코드(가짜 스토어 버튼 제거) | u3 T09·T44 |
| R03 | `classes`(소속) / `schools/{s}/courses`(수업반) / 차시 `roomName`(교실) | u1 R03, u4 R03, 단위 resolve |
| R04 | 수업 초대 = 수강 추가, 소속 불변 | sa3 T04, u3 T04, u4 R04 |
| R05 | 학생 홈 = 개인 시간표, 학급 시간표는 참고 영역 | u1, r01-verify A.4·A.5 |
| R06 | 날짜 이동·선택·오늘로, 어제/오늘/내일/모레 | u1 T11·T12, 단위 dates |
| R07 | 공식 수업 찾기·신청 + 직접 입력 | u2 T13·T14·R07 |
| R08 | 직접 입력은 '학교 시간표와 연결되지 않음' | u1 R08, u2 T14 |
| R09 | 변경은 수강생에게만 반영·알림 | sa2 T16, u5 T16 |
| R10 | 빨간 테두리 + 텍스트 배지 + 전후 | u1 T16, u5 T16 |
| R11 | 이 날짜만 / 지정일부터 기본 변경 | sa2 T21, u2 R11, u1 R11 |
| R12 | 세 엑셀 통합(importMatch) | 단위 T29–T33, im1 |
| R13 | 시간표와 수강 자료 분리, 명단·초대·신청 경로 | im1 T32, im2 T32, u4 T32 |
| R14 | 초대 코드 `/i/{code}`, 보관 초대 이어가기, 코드 입력 | u3 T08·T09·T10 |
| R15 | 상태 구분(로그인·가입·학교·소속·수업 없음·대기·미등록·학기 밖·휴업·오프라인·권한·서버) | u1 T34·T35·T37, u2 T34 |
| R16 | 서버 권한 + 규칙 + 마이그레이션 dry-run/복구 | rules, sa4, u4 R16, migration T41 |
| R17 | 단위·규칙·API·E2E | 이 문서 |
| R18 | 급식·공지·이야기방·학생 관리·푸시 토큰 등 기존 기능 | `tests/e2e/regression.e2e.mjs`(F1–F13, 158 체크) |
| R19 | 교사 메인 = 교사 본인 시간표(공식 수업 uid 기준 + 직접 등록 주간 시간표 + 품앗이·보결 표시), 반 시간표는 링크만 | 단위 teacher-home-*, sa5, u6 |
| R20 | 학생 '수업 담기' — 학교 공식 수업을 시간표 칸·과목으로 골라 담기(이름 입력·이름 연결 없음), 반별 수업은 그 반 학생에게만, 겹침 경고, 내가 담은 수업만 빼기(다시 승인 우회 차단), 가져오기 공개·대상 학년·대상 반, 직접 입력은 학교 밖 일정으로 안내 | 단위 course-picker-*, sa6, u7, u2 |
| R21 | 교사 내 시간표 주간 보기(`/teacher/timetable`, 주간·하루 탭) — 요일×교시 표, 변경·대신·취소·옮김 빨간 표시, 교시 밖 줄, 쉬는 날 열, 직접 등록 주간 시간표·혼합 주, 주 이동, 실시간 갱신. 홈 카드 '주간 시간표 →'·대시보드 '내 시간표 (주간)' | 단위 teacher-week-*, u8 |

## 5. 인수 시나리오(T) → 테스트

| T | 테스트 | 비고 |
|---|---|---|
| T01 | r01-repro(재현), r01-verify, u1 T01 | |
| T02 | sa3 T02, u3 T02 | 가입 직후 수업 초대 수락 |
| T03 | sa1 T03, u1 T03, u4 T03, r01-verify A2 | |
| T04 | sa3 T04, u3 T04, u4 T04 | |
| T05 | sa1·sa3·im2 T05, u3 T05 | |
| T06 | sa3 T06, u4 T06 | |
| T07 | sa3 T07, u3 T07, u4 T07 | |
| T08 | sa3 T08(401), u3 T08 | |
| T09 | u3 T09 | 실기기(iOS 홈 화면 앱) 미검증 |
| T10 | u3 T10, u1 T10 | |
| T11 | sa1 T11, u1 T11, 단위 | |
| T12 | u1 T12(월말·연말), 단위 dates | 학기 전환은 studentData terms |
| T13 | sa1·u1·u2·u4 T13 | |
| T14 | rules·sa4 T14, u2 T14 | |
| T15 | rules·sa4 T15, u2 T15, 단위 | |
| T16 | sa2·u1·u5 T16, 단위 | |
| T17 | sa2 T17, u5 T17, 단위 | |
| T18 | sa2 T18, 단위 | |
| T19 | sa2 T19, 단위 | |
| T20 | sa2 T20, 단위 | |
| T21 | sa1·sa2·im1 T21 | |
| T22 | sa2 T22, 단위 | |
| T23 | sa2·im1 T23 | |
| T24 | sa1 T24, u2·u4 T24 | |
| T25 | sa1·sa2 T25, 단위 | |
| T26 | sa1·sa2 T26, u5 T26 | |
| T27 | sa2·im1 T27, u5 T27 | |
| T28 | sa2·im1·im2 T28 | |
| T29 | 단위·im1 T29 | |
| T30 | 단위·im1·im2 T30 | |
| T31 | 단위·im1 T31 | |
| T32 | im1·im2·u4 T32 | |
| T33 | 단위·im1·im2 T33 | |
| T34 | u1·u2 T34, sa1 T34 | |
| T35 | u1 T35, sa1 T35 | |
| T36 | u1 T36, sa1 T36 | |
| T37 | u1 T37 | |
| T38 | sa2 T38(영향 학생에게만 인앱 알림 1건) | 실제 FCM 푸시 수신은 미검증(FCM 미설정) |
| T39 | rules·sa4·sa1·sa2·sa3·im1·im2·u4·u5 T39 | |
| T40 | sa1·sa2·sa3·im1·im2 T40, u5 T40 | |
| T41 | migration T41, r01-verify B2 | 운영 데이터 dry-run은 미실행(승인 필요) |
| T42 | sa3 T42, u3 T42 | |
| T43 | `tests/e2e/regression.e2e.mjs`(F1–F13) | 과제 기능은 저장소에 없음 |
| T44 | u3 T44(iOS 사용자 에이전트 안내) | Android 설치 버튼·standalone·실기기 미검증 |
| T45 | u5 T45(390px 가로 스크롤·pageerror), u1·u2 레이아웃 | 큰 글자 설정은 미검증 |
| T46 | sa1·sa2·sa3·im1·im2·u3·u4·u5 T46 | 앱 번들 비밀값 검사는 7절 |

## 6. 실행 중 발견해 고친 결함 (요약)

- 로그인·가입·`/join` 폼: 하이드레이션 전에 제출되면 브라우저 기본 GET 제출로 **이메일·비밀번호가 URL 쿼리에 실림**(기존 결함, E2E에서 재현) → 폼 `method="post"` + 하이드레이션 전 제출 버튼 비활성.
- 화면 이동 안내(route announcer)가 문서 제목이 없을 때 주소(`/teacher/courses/<수업 id>`)를 읽어 내부 id 노출 → 앱 기본 제목.
- 교사 변경 화면: '최신 시간표로 다시 미리보기' 직후 예전 미리보기로 발행 가능(다시 409), 변경 이력이 늦게 온 다른 수업 응답으로 덮임 → 수정.
- 독립 검토(4개 영역 × 정확성·보안 관점, 53건 → 반박 검증 후 42건 실제 결함)에서 확인된 결함을 고침. 주요 항목: 수강 종료 후 지난 날짜에서 수업이 사라짐, 지난 학기 수업이 계속 '운영 중', 보강 안내가 수강하지 않는 학생에게 보임, 동시 승인 시 발행이 멈춤, 승인 때 새 충돌이 요청자 확인으로 통과, 학급 시간표 재실행이 기본 변경으로 옮긴 칸을 중복 생성, 가져오기 행 단위 검토 항목이 제외되지 않음, 멈춘 가져오기 배치 복구 불가, 수강 변경만으로 가져오기 발행이 막힘, 교사 연결 확인이 이름-계정 쌍이 아님, 명단 수업 코드·분반 접두어 매칭 실패, 학생이 자기 번호를 바꿔 명단 연결을 가로챌 수 있음, 그룹 QR이 승인 정책을 무시함, 재신청 알림이 막힘, 마이그레이션 복구가 참조 중인 수업을 삭제함, 시간표 카드가 날짜 왕복 시 멈춤, 소속 없는 학생에게 승인 대기 배너, 초대 코드가 서비스 워커 캐시에 남음, 익명 세션을 로그인으로 처리, 프로필 없는 교사가 교사 인증으로 갈 수 없음, 미래 종료일 수업을 종료로 처리, 확인하지 않은 차시 입력 저장, 지난 날짜 차시 변경 허용, 수업 목록이 인원 수 때문에 학생 명단을 받아 옴 등. 각 결함마다 회귀 테스트를 추가함.

## 7. 최종 실행 결과

실행 환경: 로컬 브랜치 `feature/personal-timetable`(기준 `b7d6c46` + 이번 변경. 실행은 커밋 직전 작업 트리에서, 커밋 내용과 같음 — `src/lib/firebase.ts`의 로컬 전용 에뮬레이터 연결 코드만 커밋에서 뺌), 2026-10-03(서버 날짜), 브라우저 시각은 시나리오마다 2026-10-06 등으로 고정. 로컬 에뮬레이터·로컬 프로덕션 빌드·NEIS 가짜 응답.

| 묶음 | 명령 | 결과 |
|---|---|---|
| 타입 검사 | `npx tsc --noEmit -p .` | 오류 0 |
| 프로덕션 빌드 | `next build`(로컬 E2E 설정) | 성공 |
| 커밋본 빌드 | 커밋본을 따로 꺼내(로컬 전용 연결 코드 없음) `tsc` · `npm run test:unit` · `next build --webpack`(가짜 공개 설정) | 오류 0 · 554/554 · 성공, 번들에 에뮬레이터 주소·서버 비밀값 없음 |
| 단위 | `npm run test:unit` | **554/554** |
| 보안 규칙 | `node --test tests/rules/` | **27/27** |
| 수업·수강·개인 시간표 API | `tests/api/sa1-student-courses.test.mjs` | **82/82** |
| 변경 발행 API | `tests/api/sa2-schedule-changes.test.mjs` | **99/99** |
| 초대·/join API | `tests/api/sa3-invitations.test.mjs` | **71/71** |
| 규칙(서버 경유) | `tests/api/sa4-rules.test.mjs` | **33/33** |
| 시간표 가져오기 API | `tests/api/im1-import.test.mjs` | **122/122** |
| 수강 명단 API | `tests/api/im2-roster.test.mjs` | **49/49** |
| 교사 내 시간표 API | `tests/api/sa5-teacher-timetable.test.mjs` | **47/47** |
| 학생 수업 담기 API | `tests/api/sa6-course-picker.test.mjs` | **75/75** |
| 데이터 전환(T41) | `tests/e2e/migration.test.mjs` | **25/25** |
| R01 해결 확인 | `tests/e2e/r01-verify.mjs` | **24/24** |
| 학생 홈·개인 시간표 | `tests/e2e/u1-student-home.e2e.mjs` | **78/78** |
| 학생 내 수업·직접 입력 | `tests/e2e/u2-student-courses.e2e.mjs` | **79/79** |
| 초대·로그인 복구·설치 안내 | `tests/e2e/u3-invite-install.e2e.mjs` | **67/67** |
| 교사 수업 관리·초대 | `tests/e2e/u4-teacher-courses.e2e.mjs` | **55/55** |
| 교사 시간표 변경 | `tests/e2e/u5-schedule-changes.e2e.mjs` | **29/29** |
| 교사 메인 '오늘의 내 수업' | `tests/e2e/u6-teacher-home.e2e.mjs` | **30/30** |
| 교사 내 시간표 주간 보기 | `tests/e2e/u8-teacher-week.e2e.mjs` | **48/48** |
| 학생 수업 담기(골라 담기) | `tests/e2e/u7-course-picker.e2e.mjs` | **48/48** (`next build --webpack` — 이 환경의 가짜 xlsx를 실제 SheetJS로 바꿔 끼우는 테스트 장치가 webpack 조각 형식만 알아봄. 다른 묶음은 기본 Turbopack 빌드) |
| 기존 기능 회귀(F1–F13) | `tests/e2e/regression.e2e.mjs` (이야기방·공지 읽음·명단·푸시 요청 검증·규칙·주요 화면 스모크) | **158/158** |
| 앱 번들 비밀값 검사(T46) | `.next/static`에서 서비스 계정 키·private_key·CRON_SECRET·firebase-admin·서버 전용 함수 이름 검색 | 0건 |

ESLint는 저장소에 설정 파일이 없어(기존 상태) 실행하지 않았습니다.

### 운영 반영 전 점검 (에뮬레이터가 잡지 못하는 항목)

에뮬레이터는 복합 인덱스를 강제하지 않으므로, 운영에서만 드러나는 문제를 따로 점검했습니다. 5개 관점(인덱스, 배포 순서·혼합 버전, Vercel 운영 환경, 전환 스크립트 안전성, 기존 사용자 첫날 영향)으로 나눠 찾고, 항목마다 독립 반박 검증을 거쳤습니다. 29건 중 22건이 확인됐고(중복 포함) 7건은 반박됐습니다. 확인된 항목은 모두 고치고 위 표에 회귀 테스트를 더했습니다.

- 인덱스: 교사 '전체 시간표'가 쓰는 `classes(schoolCode, grade, classNm)`이 파일에 없어, 첫 배포 때 삭제 후보로 뜰 수 있었음 → 파일에 추가. 쓰는 쿼리가 없는 복합 인덱스 5개 제거. 승인 대기 목록은 상태를 `limit(200)` 전에 쿼리로 거름(처리된 요청이 200건 넘게 쌓이면 새 요청이 빠지던 문제). 단위 `prod-a-*`가 코드의 쿼리 모양과 인덱스 파일을 대조함.
- 배포 순서: 문서의 '앱 → 규칙·인덱스'는 틀렸음 → **백업 → 인덱스(READY 확인) → 규칙 → 바로 앱 → 전환 dry-run → 승인 후 적용**으로 고침(`docs/classmate-timetable-migration.md` 2·3절).
- 전환 스크립트: 복구가 남기는 수업의 수강까지 지우던 문제, 교사가 목록에서 뺀 그룹도 수업으로 만들던 문제, `--school`이 빈 값이면 전체 학교로 넓어지던 문제, 복구가 `--school`을 무시하던 문제, 여러 실행 로그 복구, 자격 증명(ADC)·할당량 프로젝트 안내, 복구에도 `--confirm-production` 요구.
- 학생 홈(기존 사용자 첫날): 직접 입력을 하나라도 추가하면 홈에서 학급 시간표(참고)가 사라지고 '수업이 없어요'로 보이던 문제, 승인 대기 학생이 보던 학급 시간표를 잃던 문제, `/api/timetable/me` 오류 때 학급 시간표도 못 보던 문제, '지금' 교시·교시 시각 표시 누락, 저녁 '내일 가방' 알림이 가방 체크리스트가 없는 화면으로 열리던 문제.
- 직접 입력 구독: 권한·네트워크 오류 뒤 화면 복귀 때 자동 재연결, 로그인 상태의 권한 오류는 '지금은 저장할 수 없어요'로 안내.

### 미실행·미검증 (완료로 보고하지 않음)

- 실기기: iOS Safari·홈 화면 앱, Android Chrome·설치 앱(beforeinstallprompt, standalone), 카카오톡 등 인앱 브라우저의 구글 로그인.
- 실제 FCM 푸시 수신(T38): 이 환경에 FCM 설정이 없어 인앱 알림 문서까지만 확인.
- 운영 Firestore: 규칙·인덱스 배포, 복합 인덱스 충분성(에뮬레이터는 강제하지 않음), 운영 데이터 마이그레이션 dry-run.
- 실제 학교 엑셀·컴시간 파일·수강 명단(표본 없음). 이 환경의 `xlsx`는 실제 라이브러리가 아니어서 엑셀 업로드 화면 E2E는 정규화 행 API로 대신함.
- 큰 글자(접근성 글꼴 크기) 설정, 다크 모드(앱이 지원하지 않음).
- 같은 학교 여러 서버 인스턴스 간 시도 제한 공유(메모리 기준).
