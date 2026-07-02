// netlify/functions/get-sms.js
// Proxy sécurisé vers SMSPVA : le navigateur ne voit jamais la clé API,
// et on vérifie que le numéro demandé appartient bien à l'utilisateur connecté
// (sinon n'importe qui pourrait lire les SMS de n'importe qui en devinant un id).

const fetch = require('node-fetch');
const { db, requireUser } = require('./_firebase');
const { COUNTRY_SMSPVA } = require('./_countries');

const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;

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

    // Vérification d'appartenance : empêche un utilisateur de lire les SMS d'un autre
    if (num.uid !== user.uid) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Accès refusé.' }) };
    }

    const countryKey = COUNTRY_SMSPVA[num.country];
    const smsRes = await fetch(
      `https://smspva.com/priemnik.php?metod=get_sms&country=${countryKey}&service=opt18&id=${num.smspvaId}&apikey=${SMSPVA_API_KEY}`
    );
    const data = await smsRes.json();

    if (data.response !== '1' || !data.sms) {
      return { statusCode: 200, body: JSON.stringify({ received: false }) };
    }

    const codeMatch = String(data.sms).match(/\b\d{4,8}\b/);
    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        sms: data.sms,
        code: codeMatch ? codeMatch[0] : null,
        service: data.service || 'Inconnu'
      })
    };

  } catch (err) {
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ error: err.message || 'Erreur serveur.' })
    };
  }
};
