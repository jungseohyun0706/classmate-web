# Classmate 현황 진단 (개인 시간표 개편 전)

- 진단 기준: 브랜치 `feature/mobile-rebirth` HEAD `b7d6c46`(작업 worktree `e2e-fixes`). 이번 세션 이전 기준점은 `665687a`입니다.
- 방법: 코드 정적 추적(파일:줄 근거는 진단 원문에 있음) + **로컬 Firebase 에뮬레이터·실제 Next 서버·Chromium 재현**(`tests/e2e/r01-repro.mjs`, NEIS는 `tests/support/neis-mock.cjs`로 가짜 응답).
- 운영 데이터는 조회하지 않았습니다. 운영에서 실제로 어떤 조건에 해당하는지는 9절의 확인 질의가 필요합니다.

## 1. 실행 환경

| 항목 | 현재 |
|---|---|
| 앱 | Next.js 16.1.6 pages router, React 19, Tailwind 4. 웹 + PWA(`public/manifest.webmanifest`, `public/sw.js`). **Expo/React Native 앱은 이 저장소에 없음** |
| 인증·DB | Firebase Web SDK v12(Auth, Firestore `persistentLocalCache`), 서버는 Next API 라우트에서 firebase-admin |
| Functions | 없음(Cloud Functions 미사용). 배치는 Vercel Cron(`vercel.json`) |
| 규칙·인덱스 | `firestore.rules` 있음, `firestore.indexes.json` 없음(이번 작업에서 추가) |
| 배포 | classmate.kr은 Vercel CLI(`vercel --prod`)로 배포. GitHub 연결은 Preview만 |
| 네이티브 앱 근거 | `public/.well-known/assetlinks.json`(Android TWA 패키지 `com.jungseohyun7.classmate`)만 있음. 스토어 URL·Android 프로젝트·iOS 앱·`apple-app-site-association` 없음 |
| 실제 자료 | 저장소·작업 환경·git 이력 어디에도 엑셀·CSV·수강 명단 샘플이 없음 |

### 명령 기준 상태 (수정 전)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit -p .` | 통과 |
| `npm run build` (더미 env) | 통과 |
| `npm run lint` | **실패(기존)** — ESLint 9용 설정 파일(`eslint.config.*`)이 없음 |
| 테스트 | 저장소에 테스트 없음 → 이번 작업에서 `npm run test:unit`(tsc → `node --test`, 의존성 추가 없음), `tests/rules`, `tests/api`, `tests/e2e` 추가 |

## 2. 데이터 구조 요약 (수정 전)

| 데이터 | 위치 | 비고 |
|---|---|---|
| 학생 소속 | `users.classId`(+ `status`, `grade`, `classNm`) | 수업 그룹 QR로 처음 들어온 학생은 그룹이 소속처럼 저장됨 |
| 수업 그룹 | `classes/{학급}_g_{교사uid6}`(isGroup) | 행정 학급 × 교사. 과목·요일·교시·교실 없음. 톡방·공지·명단 공간 |
| 추가 참여 | `users.extraClassIds` | 그룹 톡방·명단 권한. 시간표에는 쓰이지 않음 |
| 학급 시간표 | `classes/{id}/info/timetable` = `{mon..fri: 과목[7]}` | 교사·교실·수업반 정보 없음 |
| 학교 시간표 마스터 | `school_timetables/{school}` | 엑셀 파싱 결과(반·교사 그리드, 교실 포함). 학생은 읽을 수 없음 |
| 하루 변경 | `classes/{id}/overrides/{ymd}` = `{periods:{교시:{subject, reason}}}` | 교환 수락이 담임 반에만 기록. 변경 종류·전후·대상 학생 없음 |
| NEIS | `/api/timetable` | 학년·반 단위 학급 시간표 |
| 학생 실제 수강 | **없음** | 학생 개인 시간표를 만들 근거 데이터가 없음 |

## 3. QR 초대 학생 시간표 미표시 — 실제 원인 (R01 / T01)

급식과 시간표는 필요한 키가 다릅니다. 급식은 `users.schoolCode`만으로 나오지만, 시간표는 학년·반 + 학교 종류에 맞는 NEIS 데이터셋 + (없으면) 학급 시간표 문서 + 읽기 권한이 모두 필요합니다. 그래서 "급식은 보이는데 시간표만 빈" 상태가 생깁니다.

에뮬레이터 재현 결과(`tests/e2e/out-r01-baseline/`, `tests/e2e/out-r01-head/`의 results.json·스크린숏):

| 재현 | 조건 | 665687a | b7d6c46 | 원인 |
|---|---|---|---|---|
| A | 고등학교, 담임 학급 QR 가입·승인, 학급 시간표 문서 없음, NEIS에 고교 시간표 있음 | **급식만, "오늘 시간표 정보가 없어요"** | 6교시 표시 | 665687a의 `/api/timetable`이 학교 종류와 무관하게 초등 데이터셋(`elsTimetable`)만 조회 → 고교는 항상 빈 결과(서버 로그로 확인). `974560a`에서 학교 종류별 데이터셋으로 수정됨 |
| B | 담임이 앱에 없고 교과 교사의 수업 그룹 QR로만 가입·승인 | **급식만, 빈 시간표** | **급식만, 빈 시간표** | 그룹이 소속처럼 저장되고(학년·반 null 또는 그룹 원본 반), 그룹에는 시간표를 쓰는 곳이 없음. 학생의 실제 수강 관계가 데이터에 없음(구조적 원인) |
| D | 시간표 NEIS 호출 실패(HTTP 500) | 빈 시간표 | **"오늘 시간표 정보가 없어요"** | `/api/timetable`이 모든 실패를 `200 {timetable: []}`로 반환 → 오류가 '시간표 없음'으로 위장 |
| H2 | 담임 반에 신청(승인 전) 후 그룹 QR | — | **담임 반 신청이 그룹으로 덮어써짐** | `/api/join`이 미승인 학생의 소속을 마지막 QR 대상으로 교체 |
| G | 학급 문서 읽기 권한 거부(문서 삭제 등) + NEIS 빈 결과 | — | **"오늘 시간표 정보가 없어요"** | `TodayCard`가 Firestore 읽기 오류를 `catch {}`로 삼킴 |

결론: 운영 장애는 (1) 665687a 시점의 중·고교 NEIS 데이터셋 오류(이미 수정), (2) **학생의 실제 수강 관계가 없고 학급 단위 데이터만 있어** 수업 그룹 QR 학생에게 보여 줄 시간표 근거가 없는 구조, (3) 조회 실패를 '시간표 없음'으로 숨기는 오류 처리가 겹친 것입니다. 운영 학생이 정확히 어느 경우인지는 9절 질의로 확인해야 합니다.

해결 방향(학급 시간표를 개인 시간표처럼 대신 보여 주지 않음): 수업반·수강·반복 차시·차시 변경 모델을 추가하고(`docs/classmate-timetable-architecture.md`), 학생 홈을 수강 관계 기준 개인 시간표로 바꾸며, 조회 실패·미연결·미등록·쉬는 날을 구분해 안내합니다.

## 4. 조사 후보 판정

| 후보 | 판정 |
|---|---|
| 초대 완료 전 조회 | 원인 아님 — 프로필(classId·schoolCode)이 생긴 뒤에만 시간표 카드를 그림 |
| 명단과 uid 연결 | 해당 코드 없음 — 사전 명단이 없고 QR 신청 승인만 있음 |
| classId·학년반·학교코드 혼용 | 그룹 학생 학년·반 null(확정), 0채움 예전 classId(가설) |
| 업로드 요일·교시와 조회 일치 | 일치(mon..fri, 0번=1교시). 7교시·월~금 고정, 8교시·토요일·분반 접두어·교실은 변환에서 버려짐 |
| 권한 실패·인덱스 누락 숨김 | 권한 실패 숨김 확인(재현 G). 학생 경로는 getDoc만 써서 인덱스 무관 |
| 로컬 캐시 우선 적용 | 계속 비는 원인 아님(getDoc은 서버 우선) |
| 다른 계정 캐시 | 온라인 기준 해당 없음. 로그아웃 시 캐시 정리 코드는 없음 |
| 변환·필터링 제거 | 정상 데이터는 제거되지 않음 |
| 프로필은 있는데 수업 관계 없음 | **해당(구조적)** |
| 웹·네이티브 다른 경로 | 네이티브 앱 코드가 저장소에 없어 확인 불가 |

## 5. 초대·설치 현황 요약

- 초대 형식은 `/join?c={classId}&t={32hex}` 하나, 10분 TTL, 다인용, 회수·짧은 코드·시도 제한 없음. 초대 정보는 URL에만 있어 탭을 벗어나거나 설치 후에는 복구할 수 없음.
- 랜딩(`/`)에 동작하지 않는 "Google Play 출시 예정 / iOS 앱스토어 준비 중" 버튼만 있고 설치·초대 코드 입력이 없음. 설치 안내는 교사 대시보드·학생 오늘 화면에만 있음.
- 학생은 `/auth/login`에서 계정을 만들 수 없음(회원가입은 교사 전용) — 학생 가입은 초대 화면에서만.

## 6. 보존해야 할 기존 기능

급식(TodayCard·`/api/meals`·`/meals`), 공지·알림장(`classes/{id}/announcements`, 읽음 확인·동의), 이야기방(`/class-room`), 학생 관리·QR 승인(`/teacher/students`, `/teacher/class-qr`), 반 이동, 푸시(EnablePush·`fcm-admin`·`firebase-messaging-sw.js`), 교환·SOS, 시간표 업로드, 브리핑 크론. "과제(TaskItem)" 기능은 이 저장소에 없습니다.

## 9. 운영 데이터 확인 질의 (실행하지 않음 — 승인 후 읽기 전용으로)

1. 장애 학생 `users/{uid}`: `classId`에 `_g_` 포함 여부, `grade`·`classNm` null 여부, `status`, `extraClassIds`, `pendingClassId`
2. 그 `classes/{classId}` 존재·`schoolCode`·`info/timetable` 존재, 예전 `timetable` 필드
3. 학교 NEIS `schoolInfo`의 학교 종류, 해당 날짜·학년·반의 NEIS 시간표 응답 코드
4. 장애 보고 날짜와 당시 배포 버전(665687a 이전/이후)
