// netlify/functions/refresh-prices.js
// Fonction PLANIFIÉE SÉPARÉE — s'occupe UNIQUEMENT des prix, par petits lots.
// Pourquoi séparée de refresh-availability.js : Netlify limite chaque fonction
// planifiée à 30 secondes. Avec ~126 combinaisons pays/service à vérifier
// (42 pays × 3 services), tout faire d'un coup dépasse cette limite et fait
// échouer la fonction en silence (aucune erreur visible, juste rien qui se
// met à jour). Solution : un curseur mémorisé dans Firestore qui avance à
// chaque exécution, en ne traitant qu'un petit lot à la fois.

const fetch = require('node-fetch');
const { db } = require('./_firebase');
const { COUNTRY_SMSPVA } = require('./_countries');
const { getSmspvaDailyPrice } = require('./_providers');

// Les 3 seuls services vendus sur le site (whitelist, voir create-transaction.js).
const PRICED_SERVICES = ['whatsapp', 'tiktok', 'telegram'];

// Nombre de combinaisons pays/service traitées PAR exécution.
// 20 combinaisons × ~0.3-0.5s par appel réseau ≈ 6-10s, largement sous la
// limite de 30s même avec de la marge pour la latence réseau.
const BATCH_SIZE = 20;

exports.handler = async () => {
  // Construit la liste complète et STABLE de toutes les combinaisons
  // pays/service possibles (l'ordre ne doit pas changer d'une exécution à
  // l'autre, sinon le curseur n'aurait plus de sens).
  const allPairs = [];
  for (const siteCode of Object.keys(COUNTRY_SMSPVA)) {
    for (const service of PRICED_SERVICES) {
      allPairs.push({ siteCode, service });
    }
  }

  const cursorRef = db.collection('availability').doc('priceCursor');
  const cursorSnap = await cursorRef.get();
  const startIndex = cursorSnap.exists ? (cursorSnap.data().index || 0) : 0;

  const batch = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const idx = (startIndex + i) % allPairs.length;
    batch.push(allPairs[idx]);
  }

  const warnings = [];
  let updated = 0;

  for (const { siteCode, service } of batch) {
    try {
      const pricePerDayUSD = await getSmspvaDailyPrice(siteCode, service);
      await db.collection('servicePricing').doc(`${siteCode}_${service}`).set({
        pricePerDayUSD,
        updatedAt: Date.now()
      });
      updated++;
    } catch (e) {
      warnings.push(`${siteCode}/${service} (${e.message})`);
      // On garde l'ancien prix en cache plutôt que de l'effacer en cas d'erreur.
    }
  }

  // Avance le curseur pour la prochaine exécution (boucle indéfiniment sur
  // la liste complète — un cycle complet prend environ
  // Math.ceil(allPairs.length / BATCH_SIZE) exécutions).
  const nextIndex = (startIndex + BATCH_SIZE) % allPairs.length;
  await cursorRef.set({ index: nextIndex, lastRunAt: Date.now() });

  if (warnings.length > 0) {
    console.warn('refresh-prices: prix non mis à jour pour ce lot:', warnings);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      batchStart: startIndex,
      batchSize: batch.length,
      updated,
      warnings: warnings.length
    })
  };
};
