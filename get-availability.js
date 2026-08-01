// netlify/functions/get-availability.js
// Endpoint PUBLIC (pas d'authentification requise — juste de la lecture de
// données non sensibles). Le front l'appelle au chargement de la page pour
// savoir quels pays afficher comme disponibles/indisponibles.
// Lit uniquement le cache Firestore rempli par refresh-availability.js —
// ne parle jamais directement à SMSPVA (pas de clé API ici).

const { db } = require('./_firebase');

exports.handler = async () => {
  try {
    const snap = await db.collection('availability').doc('countries').get();
    const data = snap.exists ? snap.data() : {};
    const { updatedAt, ...countries } = data;

    // Prix/jour par pays+service, alimenté par refresh-availability.js.
    // Renvoyé sous forme { "FR_whatsapp": 0.85, "GB_tiktok": 1.2, ... } pour
    // que le front puisse afficher un aperçu de prix sans attendre un
    // aller-retour supplémentaire à get-price.js à chaque changement.
    // Le prix réellement facturé reste TOUJOURS recalculé par
    // create-transaction.js au moment du paiement.
    const pricingSnap = await db.collection('servicePricing').get();
    const prices = {};
    pricingSnap.forEach(doc => {
      prices[doc.id] = doc.data().pricePerDayUSD;
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120' // évite de re-solliciter Firestore à chaque visite
      },
      body: JSON.stringify({ countries, prices, updatedAt: updatedAt || null })
    };
  } catch (err) {
    // En cas d'erreur, on renvoie une liste vide plutôt qu'un 500 — le front
    // gardera alors simplement l'affichage statique par défaut.
    return { statusCode: 200, body: JSON.stringify({ countries: {}, prices: {}, updatedAt: null }) };
  }
};
