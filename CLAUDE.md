# CLAUDE.md — Classmate 웹

컴시간알리미를 대체하는 무료 학교 시간표 서비스. 학생은 로그인 없이 시간표·급식·변경(노란 칸)을 보고, 교사는 엑셀 업로드로 전교 시간표를 등록하고 보결·맞교환을 요청/수락한다. 모바일 앱(Expo, 별도 리포)과 Firestore를 공유한다.

## 명령어

```bash
npm run dev            # 개발 서버 (localhost:3000)
npm run build          # 프로덕션 빌드 — PR 전 필수 통과
npm run lint           # eslint (flat config)
npx tsc --noEmit       # 타입체크
npx tsx scripts/test-lib.ts   # 핵심 로직 단위 테스트 31개 — 시간표 변환/업로드 파서 수정 시 필수
```

에뮬레이터 개발: `firebase emulators:start --project demo-classmate` → `node scripts/seed-emulator.mjs`(env는 README 참고) → `.env.local`에 `NEXT_PUBLIC_USE_EMULATOR=1`. 시드 계정 `kim@demo.school`/`demo1234`.

## 아키텍처

- Next.js 16 **pages router** + React 19 + Tailwind 4 + Firebase (Auth/Firestore/Storage)
- `src/lib/timetable.ts` — **핵심.** canonical 시간표 모델(TimetableItem[])과 legacy 그리드 포맷의 양방향 변환. 시간표 읽기/쓰기는 반드시 `readClassTimetable`/`writeClassTimetable` 경유 (양쪽 포맷 동시 기록 — 모바일 앱 호환).
- `src/lib/swaps.ts` — 교환/보결 요청 생명주기. 수락은 Firestore **트랜잭션**: 양쪽 mySchedule 갱신 + `schools/{code}/changes` 기록(학생 화면 노란 칸).
- `src/lib/uploadParse.ts` — 엑셀/CSV/붙여넣기 파서 (순수 함수, 테스트 있음).
- `src/pages/s/` — 학생 포털 (비로그인). `s/[...cls].tsx` = `/s/{schoolCode}/{grade}/{classNm}`. `schoolCode === 'demo'`면 `lib/demoData.ts` 픽스처 사용.
- `src/pages/api/complete-signup.ts` — 교사 등록 완료. 인증 코드는 서버 env `TEACHER_SIGNUP_CODE`로만 검증, role 부여는 서버에서만. **클라이언트에서 role을 쓰게 만들지 말 것.**
- `src/pages/api/schools.ts`, `api/meals.ts` — NEIS 프록시 (키는 env `NEIS_SERVICE_KEY`, 없어도 동작).
- 데이터 모델 계약: `SCHEMA.md` (모바일 앱이 지켜야 할 규칙 포함). 배포 절차: `DEPLOY.md`.

## 컨벤션

- **`firebase-admin/auth` 는 import 금지.** jwks-rsa→jose(ESM 전용) require 체인 때문에 Vercel 서버리스에서 ERR_REQUIRE_ESM으로 죽는다. ID 토큰 검증은 `lib/authVerify.ts`(Identity Toolkit REST), 서버 측 쓰기는 `lib/firebaseAdmin.ts`(Firestore 전용)만 사용한다. 교사 권한은 custom claims가 아니라 `users/{uid}.role` 문서 필드로만 관리한다.
- 알림은 `alert()` 금지 → `src/lib/toast.tsx`의 `toast(msg, 'success'|'error'|'info')`
- 교사 페이지는 `src/components/Layout.tsx`(TeacherLayout)로 감싼다 (네비 + 요청 배지)
- Firestore 쿼리에 `orderBy`+`where` 복합 인덱스 조합을 새로 만들지 말 것 — 정렬은 클라이언트에서 (기존 인덱스 2개는 `firestore.indexes.json`)
- 규칙 변경 시 `firestore.rules` 함께 수정하고 DEPLOY.md 체크리스트 갱신

## 현재 상태 / 남은 일

- `feature/classmate-v2` 브랜치에 v2 전체 구현 완료 (빌드·타입·테스트 통과)
- 배포 전 필수: Vercel 402 해제, env 설정(`.env.example` 참고 — `TEACHER_SIGNUP_CODE`는 반드시 새 값), `firebase deploy --only firestore:rules,firestore:indexes,storage`
- GitHub 기본 브랜치를 main으로 정리 + 이슈 #6/#7 닫기 권장
- git 히스토리에 개인 파일 잔존 (DEPLOY.md 5번 — filter-repo 절차)
- 다음 후보: 학생 알림장 열람 화면, 교사 시간표 수정 이력, 맞교환 UI 고도화, 스토어 배포용은 PWA 그대로 TWA/Capacitor 래핑이 지름길 (모바일 Expo 앱과 스키마 계약은 SCHEMA.md 유지)
