# Classmate — 우리 반의 똑똑한 도우미

컴시간알리미를 대체하는 **무료** 학교 시간표 서비스. 웹(교사·학생)과 모바일 앱이 하나의 Firebase 데이터를 공유합니다.

## 핵심 기능

**학생 (로그인 불필요)** — `/s`
- 학교 검색 → 반 선택 → 주간 시간표 (이번 주 / 다음 주)
- 교환·보결로 바뀐 교시는 **노란 칸**으로 표시
- 오늘의 급식 + 주간 급식 (NEIS 연동)
- 링크 공유 / 홈 화면에 추가(PWA) / 최근 본 반 바로가기
- 체험 모드: `/s/demo/1/1`

**교사** — `/dashboard`
- **시간표 파일 업로드**: 엑셀(.xlsx/.csv) 하나 또는 붙여넣기로 전교 시간표 일괄 등록
- **내 시간표**: 전교 시간표에서 내 수업 자동 불러오기, 셀 클릭 → 보결/맞교환 요청
- **교환 요청함**: 수락하면 양쪽 시간표 자동 반영 + 학생 화면에 변경 표시
- 학급 시간표 직접 편집, 전체 시간표 조회, 학생 가입 승인, 알림장 작성

## 기술 스택

Next.js 16 (pages router) · React 19 · Tailwind CSS 4 · Firebase (Auth/Firestore/Storage) · exceljs

## 개발 시작

```bash
npm install
cp .env.example .env.local   # 값 채우기
npm run dev
```

### 에뮬레이터로 개발 (실제 Firebase 프로젝트 불필요)

```bash
npm i -g firebase-tools
firebase emulators:start --project demo-classmate   # auth/firestore/storage + UI(4000)

# 다른 터미널에서 데모 데이터 심기
FIRESTORE_EMULATOR_HOST=localhost:8080 \
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
node scripts/seed-emulator.mjs

# .env.local 에 추가 후 dev 서버 실행
#   NEXT_PUBLIC_USE_EMULATOR=1
#   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
#   FIRESTORE_EMULATOR_HOST=localhost:8080
#   TEACHER_SIGNUP_CODE=아무거나
npm run dev
```

시드 계정: `kim@demo.school` / `lee@demo.school` / `park@demo.school` (비밀번호 `demo1234`)

### 테스트 / 품질

```bash
npx tsx scripts/test-lib.ts   # 시간표 변환·업로드 파서 단위 테스트 (31개)
npm run lint
npx tsc --noEmit
npm run build
```

## 시간표 업로드 형식

한 줄에 한 교시. 헤더는 있어도 되고 없어도 됩니다. 업로드 페이지에서 엑셀 템플릿을 받을 수 있습니다.

| 학년 | 반 | 요일 | 교시 | 과목 | 선생님(선택) |
|---|---|---|---|---|---|
| 1 | 1 | 월 | 1 | 국어 | 김철수 |
| 1 | 1 | 월 | 2 | 수학 | 이영희 |

전교 모든 반을 한 파일에 넣으면 반별로 자동 분류됩니다. 엑셀에서 범위를 복사해 붙여넣어도 동일하게 동작합니다.

## 문서

- [SCHEMA.md](./SCHEMA.md) — Firestore 데이터 모델과 모바일 앱 연동 계약
- [DEPLOY.md](./DEPLOY.md) — Vercel/Firebase 배포 절차와 보안 체크리스트
