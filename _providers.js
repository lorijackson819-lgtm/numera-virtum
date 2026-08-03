// netlify/functions/_providers.js
// Centralise tous les appels à l'API SMSPVA.
// Deux flux DISTINCTS et confirmés via docs.smspva.com (11/07/2026) :
//   - TEMP    : API REST "activation" v2  → https://api.smspva.com/activation/...
//   - MENSUEL : API "rent"                → https://smspva.com/api/rent.php?method=...

const fetch = require('node-fetch');

const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
const ACTIVATION_BASE = 'https://api.smspva.com';
const RENT_BASE = 'https://smspva.com/api/rent.php';

const SMSPVA_SERVICE_CODES = {
  whatsapp: 'opt20',
  tiktok:   'opt104',
  telegram: 'opt29',
  other:    'opt19'
};

function smspvaServiceCode(service) {
  return SMSPVA_SERVICE_CODES[service] || SMSPVA_SERVICE_CODES.other;
}

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

  if (data.statusCode === 202) return { received: false };
  if (data.statusCode !== 200 || !data.data?.sms) return { received: false };

  const smsText = typeof data.data.sms === 'string' ? data.data.sms : JSON.stringify(data.data.sms);
  const codeMatch = smsText.match(/\b\d{4,8}\b/);
  return { received: true, sms: smsText, code: codeMatch ? codeMatch[0] : null };
}

// PRIX — utilisé par refresh-availability.js pour alimenter le cache prix.
// Confirmé via la doc officielle (03/08/2026) : la méthode est "getdata"
// (pas "getprice"), et le prix par jour est dans le champ "price_day" —
// la réponse est une LISTE de tous les services du pays, il faut donc
// chercher celui qui correspond à notre service.
async function getSmspvaDailyPrice(countryCode, service = 'whatsapp') {
  const serviceCode = smspvaServiceCode(service);
  const url = `${RENT_BASE}?method=getdata&apikey=${SMSPVA_API_KEY}&country=${countryCode.toUpperCase()}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 1 || !Array.isArray(data.data)) {
    throw new Error(`SMSPVA getdata: ${data.msg || 'format de réponse inattendu'} pour ${countryCode}.`);
  }

  const entry = data.data.find(s => s.service === serviceCode);
  if (!entry || entry.price_day === undefined) {
    throw new Error(`SMSPVA getdata: service ${serviceCode} non trouvé pour ${countryCode}.`);
  }

  return Number(entry.price_day);
}

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
    expiresAt: order.until * 1000
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
      
