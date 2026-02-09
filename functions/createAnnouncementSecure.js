const functions = require('firebase-functions');
const admin = require('firebase-admin');

try { admin.initializeApp(); } catch (e) {}
const db = admin.firestore();

// Callable function: verifies class password then creates announcement
exports.createAnnouncementSecure = functions.https.onCall(async (data, context) => {
  const { classId, password, title, body, attachments } = data || {};
  if (!classId || !password || !title) {
    throw new functions.https.HttpsError('invalid-argument', 'classId, password and title are required');
  }

  // Read class doc
  const classRef = db.collection('classes').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Class not found');
  }
  const classData = classSnap.data() || {};
  const storedPassword = classData.password;

  // For MVP we compare plaintext (app currently uses plaintext).
  if (storedPassword !== password) {
    throw new functions.https.HttpsError('permission-denied', 'Invalid password');
  }

  // Create announcement under classes/{classId}/announcements
  const annRef = await classRef.collection('announcements').add({
    title,
    body: body || '',
    attachments: attachments || [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    author: context.auth?.uid || null,
  });

  return { ok: true, annId: annRef.id };
});
