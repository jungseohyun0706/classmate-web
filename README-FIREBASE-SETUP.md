Firebase setup steps (summary)

1) Create project
 - Console: https://console.firebase.google.com/
 - Project name: classmate-web (or your preferred)

2) Enable services
 - Authentication (Email/Password or Email link)
 - Firestore (start in test mode for initial dev)
 - Storage (for attachments)
 - Functions (Node 18+)
 - Hosting (if using Firebase Hosting)

3) Create service account for Admin SDK
 - IAM & Admin > Service accounts > Create
 - Role: Firebase Admin / Project Editor
 - Create JSON key and keep it safe

4) Add Firebase config to project
 - Copy config values into .env (see .env.example)
 - Place service account JSON somewhere safe and set path in env

5) Deploy functions (after installing firebase-tools)
 - npm i -g firebase-tools
 - firebase login
 - firebase init functions
 - firebase deploy --only functions

6) Hosting & domain
 - In Hosting panel, add custom domain classmate.kr
 - Follow TXT verification steps (add TXT record at your registrar)
 - After verification, set A/AAAA or CNAME as instructed

Security notes
 - Update firestore.rules before production
 - Don't commit service account JSON to git
 - Use least privilege for service accounts

