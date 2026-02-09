const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Initialize admin SDK using service account when deployed.
try {
  admin.initializeApp();
} catch (e) {
  // already initialized
}

const db = admin.firestore();
const messaging = admin.messaging();

exports.sendNoticePush = functions.firestore
  .document('notices/{noticeId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (!data) return null;

    const title = data.title || '새 공지';
    const body = data.body ? (data.body.length > 100 ? data.body.substr(0, 97) + '...' : data.body) : '';

    // Example: send to topic 'class_all' or specific topics in data.classIds
    const topic = data.classIds && data.classIds.length ? `class_${data.classIds[0]}` : 'class_all';

    const message = {
      notification: { title, body },
      topic,
    };

    try {
      const resp = await messaging.send(message);
      console.log('Push sent:', resp);
    } catch (err) {
      console.error('Push error:', err);
    }

    return null;
  });
