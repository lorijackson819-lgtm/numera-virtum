// netlify/functions/get-price.js
// Endpoint PUBLIC (pas de clé secrète ici) appelé par le front pour afficher
// le prix live jour/semaine/mois avant paiement. Le prix RÉEL et sécurisé
// est de toute façon recalculé côté serveur dans create-transaction.js —
// cet endpoint sert uniquement à l'AFFICHAGE, jamais de source de vérité
// pour le paiement.

const { db } = require('./_firebase');
const { resolveDuration, calculatePrice } = require('./pricing');

const ALLOWED_SERVICES = ['whatsapp', 'tiktok', 'telegram'];

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const { countryCode, service, durationUnit, durationCount } = params;

    if (!countryCode || !ALLOWED_SERVICES.includes(service)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Paramètres invalides.' }) };
    }

    const duration = resolveDuration(durationUnit, parseInt(durationCount, 10));

    const priceDoc = await db.collection('servicePricing')
      .doc(`${countryCode}_${service}`).get();

    if (!priceDoc.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Prix pas encore disponible pour ce pays/service.' }) };
    }

    const { pricePerDayUSD, updatedAt } = priceDoc.data();
    const { sellFCFA } = calculatePrice(pricePerDayUSD, duration.durationDays);

    return {
      statusCode: 200,
      body: JSON.stringify({
        sellFCFA,
        durationDays: duration.durationDays,
        unit: duration.unit,
        count: duration.count,
        priceUpdatedAt: updatedAt
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Erreur serveur.' }) };
  }
};
