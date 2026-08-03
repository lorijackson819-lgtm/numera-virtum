// netlify/functions/refresh-availability.js
// Fonction PLANIFIÉE — s'exécute 2x/jour (minuit et midi, voir netlify.toml).
// UNIQUEMENT la disponibilité des pays (rapide, ~42 appels, largement sous
// la limite de 30 secondes de Netlify pour les fonctions planifiées).
// Les PRIX sont gérés séparément par refresh-prices.js.

const fetch = require('node-fetch');
const { db } = require('./_firebase');
const { COUNTRY_SMSPVA } = require('./_countries');

const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
const ACTIVATION_BASE = 'https://api.smspva.com';

// Extrait le total de numéros disponibles à partir de la réponse de
// /activation/countnumbers/{country}.
// Cet endpoint fait partie de la même famille "API REST v2" que
// /activation/number/... et /activation/sms/... (confirmés dans docs.smspva.com) :
//   - Succès  : {"statusCode":200, "data": ...}
//   - Erreur  : {"statusCode":4xx/5xx, "error":{"type":..., "description":...}}
// (confirmé le 03/08/2026 en testant directement cette famille d'endpoints —
// PAS le format {"status":0/1,"msg":...} de l'ancienne API rent.php, qui est
// une API différente).
function extractTotalCount(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.statusCode !== undefined && data.statusCode !== 200) return null; // erreur
  if (data.error) return null;

  const payload = data.data;
  if (payload === undefined || payload === null) return null;

  if (typeof payload === 'number') return payload;

  if (Array.isArray(payload)) {
    return payload.reduce((sum, entry) => {
      const c = entry?.count ?? entry?.available ?? entry?.total ?? 0;
      return sum + (Number(c) || 0);
    }, 0);
  }

  if (typeof payload === 'object') {
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
        warnings.push(`${siteCode}: ${JSON.stringify(data).slice(0, 150)}`);
        continue; // on ne touche pas au statut existant
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
    console.warn('refresh-availability: pays non mis à jour:', warnings);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ updated: Object.keys(results).length, warnings: warnings.length, sample: warnings[0] || null })
  };
};
  
