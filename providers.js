// netlify/functions/_providers.js
// Centralise tous les appels à l'API SMSPVA.
// Deux flux DISTINCTS et confirmés via docs.smspva.com (11/07/2026) :
//   - TEMP    : API REST "activation" v2  → https://api.smspva.com/activation/...
//   - MENSUEL : API "rent"                → https://smspva.com/api/rent.php?method=...

const fetch = require('node-fetch');

const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
const ACTIVATION_BASE = 'https://api.smspva.com';
const RENT_BASE = 'https://smspva.com/api/rent.php';

// ─────────────────────────────────────────────────────────────────────────
// Codes "service" SMSPVA (format opt{N}). À COMPLÉTER avec les vrais codes
// trouvés dans la "Services list" de la doc (recherche "WhatsApp" etc.)
// ─────────────────────────────────────────────────────────────────────────
const SMSPVA_SERVICE_CODES = {
  whatsapp: 'opt20',  // confirmé dans docs.smspva.com (Services list, #200)
  tiktok:   'opt104', // confirmé (#8 dans la capture précédente)
  telegram: 'opt29',  // confirmé (#5 dans la capture précédente)
  other:    'opt19'   // "OTHER" — catégorie générique
};

function smspvaServiceCode(service) {
  return SMSPVA_SERVICE_CODES[service] || SMSPVA_SERVICE_CODES.other;
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPORAIRE — API REST "activation" v2
// ═══════════════════════════════════════════════════════════════════════

async function buySmspvaTemp(countryCode, service = 'whatsapp') {
  const serviceCode = smspvaServiceCode(service);
  const url = `${ACTIVATION_BASE}/activation/number/${countryCode.toUpperCase()}/${serviceCode}`;

  const res = await fetch(url, { headers: { apikey: SMSPVA_API_KEY } });
  const data = await res.json();

  if (data.statusCode !== 200 || !data.data?.phoneNumber) {
    throw new Error(`SMSPVA ${data.statusCode}: ${data.data?.message || 'Aucun numéro temporaire disponible.'}`);
  }
  return {
    provider: 'smspva',
    providerId: String(data.data.orderId),
    phone: data.data.phoneNumber
  };
}

async function checkSmsSmspvaTemp(providerId) {
  const url = `${ACTIVATION_BASE}/activation/sms/${providerId}`;
  const res = await fetch(url, { headers: { apikey: SMSPVA_API_KEY } });
  const data = await res.json();

  if (data.statusCode === 202) return { received: false }; // pas encore reçu
  if (data.statusCode !== 200 || !data.data?.sms) return { received: false };

  const smsText = typeof data.data.sms === 'string' ? data.data.sms : JSON.stringify(data.data.sms);
  const codeMatch = smsText.match(/\b\d{4,8}\b/);
  return { received: true, sms: smsText, code: codeMatch ? codeMatch[0] : null };
}

// ═══════════════════════════════════════════════════════════════════════
// PRIX — utilisé par refresh-availability.js pour alimenter le cache prix
// ═══════════════════════════════════════════════════════════════════════
// ⚠️ Endpoint non confirmé à 100% dans la doc consultée : method=getprice
// est une supposition basée sur le pattern des autres méthodes rent.php
// (create/activate/sms). À VÉRIFIER/AJUSTER si l'appel échoue en prod —
// voir docs.smspva.com, section "rent" ou contacter leur support pour le
// nom exact du champ de prix par jour.
async function getSmspvaDailyPrice(countryCode, service = 'whatsapp') {
  const serviceCode = smspvaServiceCode(service);
  const url = `${RENT_BASE}?method=getprice&apikey=${SMSPVA_API_KEY}&country=${countryCode.toUpperCase()}&service=${serviceCode}`;

  const res = await fetch(url);
  const data = await res.json();

  // On essaie plusieurs formes plausibles de réponse, comme pour
  // extractTotalCount dans refresh-availability.js — mieux vaut logguer
  // un format inattendu que de planter ou renvoyer un prix faux.
  const raw = data?.data?.price ?? data?.data?.[0]?.price ?? data?.price ?? null;
  const pricePerDayUSD = raw !== null ? Number(raw) : null;

  if (pricePerDayUSD === null || Number.isNaN(pricePerDayUSD)) {
    throw new Error(`SMSPVA getprice: format de réponse inattendu pour ${countryCode}/${service}.`);
  }
  return pricePerDayUSD;
}

// ═══════════════════════════════════════════════════════════════════════
// MENSUEL / LOCATION — API "rent" (location longue durée, durée flexible)
// ═══════════════════════════════════════════════════════════════════════

// dtype: 'day' | 'week' | 'month' — dcount: nombre d'unités.
// Généralisé pour supporter jour/semaine/mois (voir pricing.js).
async function buySmspvaRent(countryCode, service = 'whatsapp', dtype = 'month', dcount = 1) {
  const serviceCode = smspvaServiceCode(service);
  const url = `${RENT_BASE}?method=create&apikey=${SMSPVA_API_KEY}&dtype=${dtype}&dcount=${dcount}&country=${countryCode.toUpperCase()}&service=${serviceCode}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 1 || !data.data?.[0]?.id) {
    throw new Error(`SMSPVA rent: ${data.msg || 'Aucun numéro mensuel disponible.'}`);
  }
  const order = data.data[0];
  const fullPhone = `${order.ccode}${order.pnumber}`;

  // Activation obligatoire avant de pouvoir recevoir des SMS
  const activateUrl = `${RENT_BASE}?method=activate&apikey=${SMSPVA_API_KEY}&id=${order.id}`;
  const activateRes = await fetch(activateUrl);
  const activateData = await activateRes.json();
  if (activateData.status !== 1) {
    throw new Error(`SMSPVA rent activate: ${activateData.msg || 'Échec activation du numéro mensuel.'}`);
  }

  return {
    provider: 'smspva-rent',
    providerId: String(order.id),
    phone: fullPhone,
    expiresAt: order.until * 1000 // timestamp unix (secondes) → ms
  };
}

async function checkSmsSmspvaMonthly(providerId) {
  const url = `${RENT_BASE}?method=sms&apikey=${SMSPVA_API_KEY}&id=${providerId}`;
  const res = await fetch(url);
  const data = await res.json();

  const list = data.status === 1 ? (data.data?.SmsList || []) : [];
  if (list.length === 0) return { received: false };

  const last = list[list.length - 1];
  const codeMatch = String(last.text).match(/\b\d{4,8}\b/);
  return {
    received: true,
    sms: last.text,
    code: codeMatch ? codeMatch[0] : null,
    sender: last.sender || null
  };
}

// Alias rétro-compatible : ancien appel "1 mois" utilisé par
// fedapay-webhook.js actuel. Ne pas supprimer tant que le webhook n'a
// pas été mis à jour pour appeler buySmspvaRent directement avec
// dtype/dcount venant de pendingOrders (durationUnit/durationCount).
function buySmspvaMonthly(countryCode, service = 'whatsapp') {
  return buySmspvaRent(countryCode, service, 'month', 1);
}

module.exports = {
  buySmspvaTemp,
  checkSmsSmspvaTemp,
  buySmspvaRent,
  buySmspvaMonthly,
  checkSmsSmspvaMonthly,
  getSmspvaDailyPrice,
  smspvaServiceCode
};
