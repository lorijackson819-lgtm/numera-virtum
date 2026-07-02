// netlify/functions/_firebase.js
// Initialise Firebase Admin une seule fois, réutilisé par toutes les fonctions.
// La clé de service Firebase est lue depuis une variable d'environnement Netlify
// (FIREBASE_SERVICE_ACCOUNT), jamais écrite en dur dans le code.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// Vérifie le token Firebase envoyé par le front (header Authorization: Bearer <token>)
// et retourne l'utilisateur authentifié. Lève une erreur si le token est invalide/absent.
async function requireUser(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error('Non authentifié.');
    err.statusCode = 401;
    throw err;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded; // contient decoded.uid, decoded.email
  } catch (e) {
    const err = new Error('Session invalide ou expirée.');
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { admin, db, requireUser };
