# Class chat attachments

Teachers and approved students can attach up to five files to a chat message. Teachers can also attach files to a notice. Each file is limited to 20 MiB and the combined selection to 50 MiB. Photos render in the conversation and can be expanded; documents download with their original names.

## Storage and authorization

- The server uses the existing Firebase Admin credentials and a private GCS bucket named `${NEXT_PUBLIC_FIREBASE_PROJECT_ID}-chat`. `CHAT_STORAGE_BUCKET` can override the bucket name.
- The production bucket is `classmate-mvp-9f855-chat`, in `ASIA-NORTHEAST3`, with uniform bucket access and public access prevention enforced. CORS allows `https://classmate.kr`, `https://www.classmate.kr`, and `http://localhost:3000` for POST/GET/HEAD.
- `/api/chat-attachments` checks the Firebase ID token and the same room membership used by chat: same-school teachers, or approved students in the homeroom/additional class. Pending, rejected and unrelated students cannot upload or retrieve links.
- Files go directly to storage using size-restricted, 15-minute signed POST policies. The web server only receives small JSON requests, avoiding Vercel's request-body limit for file contents.
- Policies can only write `chat-staging/`. The server verifies uploaded sizes and photo signatures, then copies immutable generations into `chat-files/` before publishing. HTML/SVG are not preview formats. Unsupported image contents are download-only.
- Download links are issued only after a room-membership and message check and expire after 10 minutes. These are bearer links for their short lifetime; they are not permanent public URLs.
- `chat_uploads` and `chat_upload_limits` are server-only collections under the existing Firestore default deny. Existing Firestore and Firebase Storage rules do not need to be loosened.
- A bucket lifecycle rule removes abandoned `chat-staging/` objects after one day. Final attachments stay with their messages; the delete endpoint removes the stored files when the author or class owner moderates a message.

## Retries and UI

The client keeps selected files when uploading fails or is cancelled. A stable UUID links retries to one message, so a lost response after a successful publish does not create a second post. Switching rooms clears the unsent selection, and room switching is disabled while sending. Image URLs are requested only for visible attachment cards; file links are refreshed when tapped.

## Validation

Run `node --test scripts/test-chat-attachments.cjs` and `npm run build`. End-to-end validation also covered real signed uploads/downloads, extra-class membership, pending/unrelated access denial, idempotent sends, teacher notices, spoofed image contents, and deleting attachments. The UI was exercised at 375 px with a synthetic test account, including selecting a photo, sending it, expanding it, sending a document without text, and downloading it.
