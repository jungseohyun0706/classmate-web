# 배포 가이드

## 0. 현재 상태 점검 (2026-08 기준)

- 기존 Vercel 배포(`classmate-web-d55x-...vercel.app`)는 **402 응답으로 일시중지** 상태 → Vercel 대시보드에서 결제/사용량(Spending Limit) 확인 필요
- `ururu.kr` 도메인은 현재 도파민뱅크가 사용 중 → Classmate용 도메인/서브도메인(예: `classmate.ururu.kr`) 결정 필요

## 1. Firebase 설정

```bash
npm i -g firebase-tools
firebase login
firebase use <프로젝트ID>

# 보안 규칙 + 인덱스 배포 (중요! 이번 리뉴얼의 핵심 보안 수정)
firebase deploy --only firestore:rules,firestore:indexes,storage
```

- `firestore.rules` — role 위조 방지, 반 탈취 방지, 학생 비로그인 조회 허용
- `firestore.indexes.json` — 교환 요청함 쿼리용 인덱스 2개

### 서비스 계정 (교사 가입 API용)

Firebase Console → 프로젝트 설정 → 서비스 계정 → **새 비공개 키 생성** → JSON 파일 내용 전체를 Vercel 환경변수 `FIREBASE_SERVICE_ACCOUNT`에 한 줄로 붙여넣기.

## 2. Vercel 환경변수

| 변수 | 설명 |
|---|---|
| `NEXT_PUBLIC_FIREBASE_*` (7개) | Firebase 웹 앱 구성값 (기존과 동일) |
| `TEACHER_SIGNUP_CODE` | **새 교사 가입 코드 — 반드시 새 값으로!** 기존 `classmate2026`은 공개 리포에 노출되었으므로 폐기 |
| `FIREBASE_SERVICE_ACCOUNT` | 서비스 계정 JSON (서버 전용) |
| `NEIS_SERVICE_KEY` | (선택) NEIS 오픈API 키 — 급식/학교검색 안정화. https://open.neis.go.kr 무료 발급 |

## 3. 배포

```bash
vercel --prod   # 또는 GitHub 연동 시 push
```

브랜치: `feature/classmate-v2` 를 `main`에 머지 후 기본 브랜치를 `main`으로 되돌리는 것을 권장 (현재 기본 브랜치가 `feature/auth-school`로 잡혀 있음).

## 4. 배포 후 체크리스트

- [ ] `/s/demo/1/1` 체험 페이지 열림
- [ ] `/auth/register` 에서 새 코드로 가입 → 인증 메일 수신
- [ ] 로그인 → 반 등록 → 시간표 업로드 → `/s`에서 학교 검색 → 학생 화면 표시
- [ ] 교환 요청 → 수락 → 학생 화면 노란 칸 확인
- [ ] Firebase Console에서 규칙 적용 확인 (시뮬레이터로 비로그인 users 읽기 = 거부)

## 5. 보안 후속 조치 (중요)

1. **Firebase API 키 로테이션은 불필요**하지만, `TEACHER_SIGNUP_CODE`는 반드시 새 값 사용
2. 공개 리포 히스토리에 남은 개인 파일(서봇 에이전트 파일, 텔레그램 ID·내부 IP가 든 `memory/`)은
   이번 커밋으로 삭제되지만 **git 히스토리에는 남아 있음**. 완전 제거하려면:
   ```bash
   # 로컬에서 (주의: 히스토리 재작성)
   git filter-repo --invert-paths --path AGENTS.md --path HEARTBEAT.md --path IDENTITY.md \
     --path SOUL.md --path TOOLS.md --path USER.md --path memory --path scripts/neis-schools.json
   git push --force origin main
   ```
   또는 리포를 비공개로 전환하는 것도 방법.
3. 남은 npm 취약점 7건(모두 moderate, firebase-admin의 전이 의존성 uuid 계열)은 상위 패키지 업데이트를 기다리면 됨.

## 6. 이슈 정리

- #6, #7 (Firebase 런타임 init 빌드 에러) — 현재 코드에서 빌드 통과 확인됨. 닫아도 됨.
