// netlify/functions/get-sms.js
// Proxy sécurisé vers SMSPVA : le navigateur ne voit jamais la clé API,
// et on vérifie que le numéro demandé appartient bien à l'utilisateur connecté.

const { db, requireUser } = require('./_firebase');
const { checkSmsSmspvaTemp, checkSmsSmspvaMonthly } = require('./_providers');

exports.handler = async (event) => {
  try {
    const user = await requireUser(event);
    const numberId = event.queryStringParameters?.numberId;
    if (!numberId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'numberId manquant.' }) };
    }

    const docRef = db.collection('numbers').doc(numberId);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Numéro introuvable.' }) };
    }
    const num = docSnap.data();

    if (num.uid !== user.uid) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Accès refusé.' }) };
    }

    // Routage selon le provider stocké au moment de l'achat
    let result;
    if (num.provider === 'smspva-rent') {
      result = await checkSmsSmspvaMonthly(num.providerId);
    } else {
      // 'smspva' (temp) par défaut, couvre aussi les anciens documents
      result = await checkSmsSmspvaTemp(num.providerId);
    }

    return { statusCode: 200, body: JSON.stringify({ ...result, service: num.service || 'Inconnu' }) };

  } catch (err) {
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ error: err.message || 'Erreur serveur.' })
    };
  }
};
                                   
