// netlify/functions/refresh-availability.js
// Fonction PLANIFIÉE — s'exécute 2x/jour (minuit et midi, voir netlify.toml).
// UNIQUEMENT la disponibilité des pays (rapide, ~42 appels, largement sous
// la limite de 30 secondes de Netlify pour les fonctions planifiées).
// Les PRIX sont gérés séparément par refresh-prices.js — ne jamais remettre
// les deux dans la même fonction, ça a dépassé la limite de temps le
// 03/08/2026 et empêchait toute écriture dans Firestore (échec silencieux).

const fetch = require('node-fetch');
const { db } = require('./_firebase');
const { COUNTRY_SMSPVA } = require('./_countries');

const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
const ACTIVATION_BASE = 'https://api.smspva.com';

// Détecte si une réponse SMSPVA est en fait une erreur (rate-limit, karma
// insuffisant, etc.) plutôt qu'un vrai résultat de stock. Sans ce garde-fou,
// une réponse d'erreur du type {"status":0,"msg":"..."} se faisait compter
// comme "0 numéro disponible" au lieu d'être ignorée.
function isErrorResponse(data) {
  if (!data || typeof data !== 'object') return true;
  if ('status' in data && Number(data.status) === 0) return true;
  if ('msg' in data && !('data' in data)) return true;
  if ('error' in data) return true;
  return false;
}

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

  return null;
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
        continue;
      }

      results[siteCode] = total > 0;
    } catch (e) {
      warnings.push(`${siteCode} (erreur: ${e.message})`);
    }
  }

  const docRef = db.collection('availability').doc('countries');
  const existing = (await docRef.get()).data() || {};

  await docRef.set({
    ...existing,
    ...results,
    updatedAt: Date.now()
  });

  if (warnings.length > 0) {
    console.warn('refresh-availability: pays non mis à jour (erreur/rate-limit/format inattendu):', warnings);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ updated: Object.keys(results).length, warnings: warnings.length })
  };
};
  
