// netlify/functions/refresh-availability.js
// Fonction PLANIFIÉE (Netlify Scheduled Function) — s'exécute automatiquement
// 2x/jour (minuit et midi, voir schedule dans netlify.toml).
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
const PRICED_SERVICES = ['whatsapp', 'tiktok', 'telegram'];

// Petite pause entre chaque appel sortant vers SMSPVA, pour éviter de
// déclencher leur limitation de débit (erreur 411 "low karma or ratelimits")
// — vu en pratique le 03/08/2026 : ~84+ appels d'un coup (disponibilité +
// prix) suffisaient à la déclencher, ce qui corrompait ensuite le cache.
const REQUEST_DELAY_MS = 150;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Détecte si une réponse SMSPVA est en fait une erreur (ex: rate-limit,
// karma insuffisant) plutôt qu'un vrai résultat de stock. Sans ce garde-fou,
// une réponse d'erreur du type {"status":0,"msg":"..."} se faisait compter
// comme "0 numéro disponible" au lieu d'être ignorée — c'est CE bug précis
// qui a fait passer tous les pays à "indisponible" d'un coup le 03/08/2026.
function isErrorResponse(data) {
  if (!data || typeof data !== 'object') return true;
  if ('status' in data && Number(data.status) === 0) return true;
  if ('msg' in data && !('data' in data)) return true;
  if ('error' in data) return true;
  return false;
}

// Détermine si un pays a du stock à partir de la réponse countnumbers.
// ⚠️ Format de réponse "succès" non confirmé à 100% dans la doc consultée —
// cette fonction essaie plusieurs formes plausibles pour rester robuste,
// et logue un avertissement si rien n'est reconnu (au lieu de planter ou
// de tout marquer indisponible par erreur).
function extractTotalCount(data) {
  if (isErrorResponse(data)) return null;

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
        // Erreur, rate-limit, ou format non reconnu : on NE TOUCHE PAS au
        // statut existant plutôt que de risquer de marquer à tort un pays
        // qui fonctionne comme "indisponible".
        continue;
      }

      results[siteCode] = total > 0;
    } catch (e) {
      warnings.push(`${siteCode} (erreur: ${e.message})`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const docRef = db.collection('availability').doc('countries');
  const existing = (await docRef.get()).data() || {};

  await docRef.set({
    ...existing,
    ...results, // écrase seulement les pays qu'on a pu vérifier avec succès
    updatedAt: Date.now()
  });

  if (warnings.length > 0) {
    console.warn('refresh-availability: pays non mis à jour (erreur/rate-limit/format inattendu):', warnings);
  }

  // ───────────────────────────────────────────────────────────────────────
  // PRIX PAR PAYS + SERVICE
  // ───────────────────────────────────────────────────────────────────────
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
      await sleep(REQUEST_DELAY_MS);
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
  
