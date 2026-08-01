// netlify/functions/refresh-availability.js
// Fonction PLANIFIÉE (Netlify Scheduled Function) — s'exécute automatiquement
// toutes les 30 minutes (voir schedule dans netlify.toml).
// Interroge SMSPVA pour savoir quels pays ont des numéros en stock actuellement,
// et écrit le résultat dans Firestore. Le front ne parle JAMAIS directement
// à SMSPVA (clé API jamais exposée), il lit ce cache via get-availability.js.

const fetch = require('node-fetch');
const { db } = require('./_firebase');
const { COUNTRY_SMSPVA } = require('./_countries');
const { getSmspvaDailyPrice } = require('./_providers');

const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
const ACTIVATION_BASE = 'https://api.smspva.com';

// Les 3 seuls services vendus sur le site (whitelist, voir create-transaction.js).
// On ne récupère le prix QUE pour ceux-là — pas la peine d'interroger SMSPVA
// pour des services qu'on ne vend pas, ça économise des appels (donc du temps
// d'exécution de la fonction planifiée).
const PRICED_SERVICES = ['whatsapp', 'tiktok', 'telegram'];

// Détermine si un pays a du stock à partir de la réponse countnumbers.
// ⚠️ Format de réponse non confirmé à 100% dans la doc consultée — cette
// fonction essaie plusieurs formes plausibles pour rester robuste, et logue
// un avertissement si rien n'est reconnu (au lieu de planter ou de tout
// marquer indisponible par erreur).
function extractTotalCount(data) {
  const payload = data?.data ?? data;

  if (typeof payload === 'number') return payload;

  if (Array.isArray(payload)) {
    return payload.reduce((sum, entry) => {
      const c = entry?.count ?? entry?.available ?? entry?.total ?? 0;
      return sum + (Number(c) || 0);
    }, 0);
  }

  if (payload && typeof payload === 'object') {
    return Object.values(payload).reduce((sum, v) => {
      if (typeof v === 'number') return sum + v;
      if (v && typeof v === 'object') {
        const c = v.count ?? v.available ?? v.total ?? 0;
        return sum + (Number(c) || 0);
      }
      return sum;
    }, 0);
  }

  return null; // format non reconnu
}

exports.handler = async () => {
  const results = {};
  const warnings = [];

  for (const [siteCode, smspvaCode] of Object.entries(COUNTRY_SMSPVA)) {
    try {
      const url = `${ACTIVATION_BASE}/activation/countnumbers/${smspvaCode.toUpperCase()}`;
      const res = await fetch(url, { headers: { apikey: SMSPVA_API_KEY } });
      const data = await res.json();

      const total = extractTotalCount(data);

      if (total === null) {
        warnings.push(siteCode);
        // Format non reconnu : on ne change pas le statut existant plutôt que
        // de risquer de marquer un pays qui fonctionne comme "indisponible"
        continue;
      }

      results[siteCode] = total > 0;
    } catch (e) {
      warnings.push(`${siteCode} (erreur: ${e.message})`);
      // En cas d'erreur réseau ponctuelle, on ne touche pas au statut existant
    }
  }

  const docRef = db.collection('availability').doc('countries');
  const existing = (await docRef.get()).data() || {};

  await docRef.set({
    ...existing,
    ...results, // écrase seulement les pays qu'on a pu vérifier avec succès
    updatedAt: Date.now()
  });

  if (warnings.length > 0) {
    console.warn('refresh-availability: pays non mis à jour (format inattendu ou erreur):', warnings);
  }

  // ───────────────────────────────────────────────────────────────────────
  // PRIX PAR PAYS + SERVICE — alimente pricing.js côté serveur et l'affichage
  // du prix jour/semaine/mois côté front.
  // ⚠️ On ne fait ça QUE pour les pays disponibles (results[siteCode] === true),
  // pour limiter le nombre d'appels sortants. Même comme ça, ça reste
  // (nb pays dispo) × 3 services appels supplémentaires toutes les 30 min —
  // à surveiller niveau durée d'exécution de la fonction si la liste de pays
  // grandit beaucoup (le temps d'exécution compte dans le crédit Netlify,
  // pas le nombre d'appels sortants en soi).
  const priceWarnings = [];
  const availableCountries = Object.keys(results).filter(code => results[code]);

  for (const siteCode of availableCountries) {
    for (const service of PRICED_SERVICES) {
      try {
        const pricePerDayUSD = await getSmspvaDailyPrice(siteCode, service);
        await db.collection('servicePricing').doc(`${siteCode}_${service}`).set({
          pricePerDayUSD,
          updatedAt: Date.now()
        });
      } catch (e) {
        priceWarnings.push(`${siteCode}/${service} (${e.message})`);
        // On garde l'ancien prix en cache plutôt que de l'effacer en cas d'erreur.
      }
    }
  }

  if (priceWarnings.length > 0) {
    console.warn('refresh-availability: prix non mis à jour:', priceWarnings);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      updated: Object.keys(results).length,
      warnings: warnings.length,
      pricesUpdated: (availableCountries.length * PRICED_SERVICES.length) - priceWarnings.length,
      priceWarnings: priceWarnings.length
    })
  };
};
