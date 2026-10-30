# Account deletion

Google Play requires apps that let people create accounts to offer deletion both inside the app and from a web page. Classmate does both with one screen, `/account/delete`:

- Teachers: 설정 › 회원 탈퇴. Students: the 회원 탈퇴 link at the bottom of the 오늘 screen.
- Web (Play Console › 앱 콘텐츠 › 데이터 보안 › 계정 삭제 URL): `https://classmate.kr/account/delete`. Signed-out visitors can sign in from there (`/auth/login?next=/account/delete` returns them to the page), or email `jungseohyun7@gmail.com` if they cannot sign in.

## Flow

1. The page shows what is deleted and what stays, then asks the person to type `탈퇴`.
2. `POST /api/account/delete` checks the Firebase ID token, requires a sign-in within the last 10 minutes (`auth_time`) and the typed confirmation, then calls `deleteAccount` in `src/lib/account-delete-admin.ts`.
3. On success the page signs out. `PushBridge` releases the device's push token as on any sign-out.

The Firebase Auth user is deleted last. If anything fails earlier, the person can sign in again and retry; every step skips what is already gone.

## What happens to each kind of data

| Data | Action |
|---|---|
| `users/{uid}` with `notifications`, `bagChecks` (profile, push tokens, my schedule) | deleted |
| Firebase Auth user | deleted last |
| `classes/*/chat` messages by the user, and their files in `chat-files/` | deleted |
| `classes/*/announcements` by a teacher, with comments, receipts and files (including legacy `notices/` files in the default bucket) | deleted |
| `classes/*/announcements/*/comments` by the user | deleted |
| `classes/*/announcements/*/receipts/{uid}` (students' read/consent records) | deleted |
| `meal_ratings/*/votes/{uid}` | deleted; the anonymous totals stay |
| `chat_uploads` drafts with their `chat-staging/` files, `chat_upload_limits/{uid}` | deleted |
| `classes` where `teacherId == uid` (homeroom and 수업 반 groups) | kept for students; `teacherId: null`, `teacherName: '담임 미정'` (same as changing class) |
| `school_swaps/{school}/direct_requests`, `requests`; `school_sos/{school}/requests` | names → `탈퇴한 선생님`; still-open requests are cancelled (or declined when sent to the user); finished ones stay because they back the other teacher's timetable |
| `school_swaps/{school}/slots` with `uid == uid` | deleted |
| `school_timetables` uploaded by the user | kept for the school; `uploadedBy` removed, `uploadedByName: '탈퇴한 선생님'` |

Left as is: notifications already delivered to other people (for example "○○ 학생이 입장을 신청했어요") and names written into `classes/*/overrides` by swaps. The page and the privacy policy say so.

## Finding a user's posts

Posts are found with collection group queries on `authorId` for `chat`, `announcements` and `comments`. Those need single-field indexes with **collection group** scope, which Firestore does not create automatically. Without them the code falls back to scanning:

- chat and teachers' notices: the user's own and owned classes plus the school's classes (for students only the school's real classes, not every teacher's 수업 반 group, to stay within the 60 s limit in large schools);
- comments: only the user's own and owned classes, so comments left in a class the user has since left can be missed;
- receipts are always scanned per class over the same classes as chat, because the document ID is the uid.

The fallback also misses posts left at a previous school by a teacher who changed school. For complete coverage, add the three exemptions in Firebase console › Firestore › Indexes › Single field (`chat`/`announcements`/`comments` › `authorId` › collection group, ascending). Each failed group query logs `account-delete: … 컬렉션 그룹 색인이 없어 반마다 찾습니다.`

Swap and SOS records are looked up only in the user's current school.

## Validation

`node --test scripts/test-account-deletion.cjs` covers the pure rules in `src/lib/accountDeletion.ts` (recent sign-in window, path guards, legacy notice URLs, swap/SOS anonymisation). The Firestore/Storage/Auth deletion itself needs a real Firebase project: try it with a throwaway teacher and student who posted in a test class, then check the table above in the console.
