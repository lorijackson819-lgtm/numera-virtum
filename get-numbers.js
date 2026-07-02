// netlify/functions/get-numbers.js
const { db, requireUser } = require('./_firebase');

exports.handler = async (event) => {
  try {
    const user = await requireUser(event);
    const snap = await db.collection('numbers').where('uid', '==', user.uid).get();
    const numbers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { statusCode: 200, body: JSON.stringify({ numbers }) };
  } catch (err) {
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ error: err.message || 'Erreur serveur.' })
    };
  }
};
