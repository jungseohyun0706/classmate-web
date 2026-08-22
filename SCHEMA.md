# Firestore 데이터 모델 (웹 ↔ 모바일 공유 계약)

웹과 모바일 앱은 아래 스키마를 공유한다. **canonical 포맷을 우선 읽고, legacy는 폴백으로만** 사용할 것.

## classes/{classId}

`classId = "{schoolCode}_{grade}_{classNm}"` (예: `7010084_1_3`)

```jsonc
{
  "classId": "7010084_1_3",
  "schoolCode": "7010084",
  "officeCode": "B10",            // NEIS 교육청 코드 (급식 조회용)
  "schoolName": "서울고등학교",
  "grade": 1,
  "classNm": 3,
  "teacherId": "uid | null",      // 담임 (없으면 null — 업로드로 생성된 반)
  "teacherName": "김철수",
  "timetable": [ /* TimetableItem[] — canonical */ ],
  "timetableUpdatedAt": "serverTimestamp",
  "timetableSource": "upload | manual"
}
```

### TimetableItem (canonical)

```jsonc
{
  "id": "월-3",        // `${요일한글}-${교시}` — 구버전 앱은 id 끝에서 교시를 추출한다
  "day": "월",         // 월|화|수|목|금 (한글 고정)
  "period": 3,         // 1~7
  "subject": "국어",
  "teacher": "김철수"  // 선택
}
```

- 쓰기: `writeClassTimetable()` 사용 — canonical(`classes.timetable`)과 legacy(`classes/{id}/info/timetable`, 요일별 문자열 배열)를 **양쪽 모두** 기록한다.
- 읽기: `readClassTimetable()` 사용 — canonical 우선, 없으면 legacy 변환.
- 앱이 다른 형태(id만 있는 항목 등)로 써도 `normalizeItems()`가 흡수한다.

## users/{uid}

```jsonc
{
  "email": "...",
  "displayName": "김철수",
  "role": "teacher | student",   // 클라이언트는 student만 생성 가능. teacher는 /api/register(admin)만
  "schoolCode": "7010084",
  "officeCode": "B10",
  "schoolName": "서울고등학교",
  "classId": "7010084_1_1",      // 담임 반 (학생이면 소속 반)
  "grade": 1, "classNm": 1,
  "status": "pending | approved", // 학생 가입 승인 (담임이 변경)
  "mySchedule": {                 // 교사 개인 시간표 (요일별 7칸 문자열 배열)
    "mon": ["국어(1-1)", "", ...], "tue": [...], "wed": [...], "thu": [...], "fri": [...]
  }
}
```

## swap_requests/{id} — 교환/보결 요청

```jsonc
{
  "schoolCode": "7010084",
  "type": "substitute | swap",
  "fromUid": "...", "fromName": "김철수", "fromClassId": "7010084_1_1",
  "toUid": "...",   "toName": "박민준",   "toClassId": null,
  "a": { "day": "금", "period": 4, "subject": "국어" },   // 요청자의 수업
  "b": { "day": "화", "period": 2, "subject": "영어" },   // swap일 때만: 상대 수업
  "note": "출장입니다",
  "status": "pending | accepted | declined | cancelled",
  "weekOf": "2026-08-17",        // 해당 주 월요일 (YYYY-MM-DD)
  "createdAt": "ts", "respondedAt": "ts"
}
```

수락(`acceptSwapRequest`)은 **트랜잭션**으로:
1. 양쪽 `users.mySchedule` 갱신 (substitute: 상대가 인계 / swap: 시간대 맞교환)
2. 요청 status 변경
3. `schools/{code}/changes` 에 변경 문서 기록 (학생 화면 노란 칸)

충돌(그 사이 시간표가 바뀜) 시 에러로 중단된다.

## schools/{schoolCode}

```jsonc
{ "code": "7010084", "officeCode": "B10", "name": "서울고등학교", "address": "...", "kind": "고등학교" }
```

### schools/{schoolCode}/changes/{id} — 시간표 변경(노란 칸)

```jsonc
{
  "weekOf": "2026-08-17",     // 이 주에만 표시
  "day": "수", "period": 3,
  "type": "substitute | swap",
  "classIds": ["7010084_1_1"], // 비어 있으면 학교 전체 대상
  "aName": "김철수", "bName": "정다은",
  "aSubject": "국어", "bSubject": null,
  "note": "국어 — 김철수 → 정다은 선생님 (보결)"
}
```

학생 페이지는 `weekOf == 이번주월요일` 로 조회 후 `classIds` 를 클라이언트에서 필터링한다 (복합 인덱스 불필요).

## 기타

- `classes/{id}/announcements/{id}` — 알림장 (title, body, attachmentUrl, authorId, createdAt, readCount)
- `school_swaps/{code}/requests|direct_requests` — 구버전 공개 장터 (호환 유지)

## 모바일 앱이 지켜야 할 것

1. 시간표는 `classes.timetable`(canonical)을 읽는다. 항목에 `period`가 없으면 `id` 끝 숫자 사용.
2. 시간표를 쓸 때도 canonical 포맷으로 (가능하면 legacy `info/timetable`도 함께).
3. 학생 계정 생성 시 `role: "student"` 만 가능 (규칙에서 강제). `status: "pending"` 으로 시작.
4. 변경 표시가 필요하면 `schools/{code}/changes` 를 `weekOf` 로 구독.
5. 교환 요청을 앱에서도 만들려면 `swap_requests` 스키마 그대로 사용.
