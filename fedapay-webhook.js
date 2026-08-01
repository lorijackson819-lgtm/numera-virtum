// netlify/functions/fedapay-webhook.js
// FedaPay appelle CETTE URL automatiquement quand une transaction change de statut.
// On revérifie TOUJOURS le statut réel auprès de l'API FedaPay avant d'acheter
// quoi que ce soit — jamais confiance au payload seul.
//
// LOGIQUE : SMSPVA gère les deux, mais via 2 API DIFFÉRENTES :
//   - type = 'temp'    → API "activation" (buySmspvaTemp)
//   - type = 'monthly' → API "rent"       (buySmspvaMonthly)
//
// À configurer dans ton dashboard FedaPay :
// URL du webhook = https://TON-SITE.netlify.app/.netlify/functions/fedapay-webhook

const fetch = require('node-fetch');
const { db } = require('./_firebase');
const { COUNTRIES, COUNTRY_SMSPVA } = require('./_countries');
const { buySmspvaTemp, buySmspvaRent } = require('./_providers');
const { resolveDuration } = require('./pricing');

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_API = 'https://api.fedapay.com/v1';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Méthode non autorisée.' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'JSON invalide.' };
  }

  const transactionId = payload?.entity?.id || payload?.data?.id || payload?.id;
  if (!transactionId) {
    return { statusCode: 400, body: 'Transaction id manquant.' };
  }

  try {
    // 1) Re-vérification du statut réel auprès de FedaPay
    const verifyRes = await fetch(`${FEDAPAY_API}/transactions/${transactionId}`, {
      headers: { 'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();
    const status = verifyData?.['v1/transaction']?.status;

    if (status !== 'approved') {
      return { statusCode: 200, body: 'Statut non approuvé, ignoré.' };
    }

    const orderRef = db.collection('pendingOrders').doc(String(transactionId));
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return { statusCode: 404, body: 'Commande introuvable.' };
    }
    const order = orderSnap.data();

    if (order.status === 'fulfilled') {
      return { statusCode: 200, body: 'Déjà traité.' };
    }

    const country = COUNTRIES.find(c => c.code === order.countryCode);
    if (!country) {
      await orderRef.update({ status: 'failed', error: 'Pays inconnu.' });
      return { statusCode: 200, body: 'Pays inconnu.' };
    }

    const smspvaCountry = COUNTRY_SMSPVA[order.countryCode];
    if (!smspvaCountry) {
      await orderRef.update({ status: 'failed', error: 'Pays indisponible chez SMSPVA.' });
      return { statusCode: 200, body: 'Pays indisponible.' };
    }

    // Cas RENOUVELLEMENT (prolongation d'un numéro mensuel/location existant)
    if (order.renewNumberId) {
      const numRef = db.collection('numbers').doc(order.renewNumberId);
      const numSnap = await numRef.get();
      if (numSnap.exists && numSnap.data().uid === order.uid && numSnap.data().renewalsLeft > 0) {
        const existing = numSnap.data();
        // Renouvelle pour la même durée que l'achat d'origine (jour/semaine/
        // mois) plutôt que toujours 30 jours fixes — cohérent avec la durée
        // flexible introduite pour l'achat initial.
        const renewalDuration = resolveDuration(existing.durationUnit, existing.durationCount);
        await numRef.update({
          expiresAt: Date.now() + renewalDuration.durationDays * 24 * 3600 * 1000,
          renewalsLeft: existing.renewalsLeft - 1
        });
      }
      await orderRef.update({ status: 'fulfilled', fulfilledAt: Date.now() });
      return { statusCode: 200, body: 'OK (renouvellement)' };
    }

    // 2) Achat du numéro — routage selon le type (API différentes chez SMSPVA)
    const service = order.service || 'whatsapp';
    // Ancien orders (avant l'ajout de la durée flexible) n'ont pas
    // durationUnit/durationCount → resolveDuration() retombe sur 'month'/1,
    // ce qui reproduit exactement l'ancien comportement fixe.
    const duration = resolveDuration(order.durationUnit, order.durationCount);
    let result;
    try {
      if (order.type === 'monthly') {
        result = await buySmspvaRent(smspvaCountry, service, duration.smspvaDtype, duration.smspvaDcount);
      } else {
        result = await buySmspvaTemp(smspvaCountry, service);
      }
    } catch (e) {
      await orderRef.update({ status: 'failed', error: e.message });
      return { statusCode: 200, body: 'Échec attribution numéro.' };
    }

    const now = Date.now();
    const isMonthly = order.type === 'monthly';
    // Pour la location, on utilise la vraie date d'expiration renvoyée par
    // SMSPVA (result.expiresAt) ; en secours, on se base sur la durée
    // choisie par le client (order.durationDays) plutôt que 30 jours fixes.
    const fallbackDurationMs = (order.durationDays || duration.durationDays) * 24 * 3600 * 1000;
    const expiresAt = isMonthly ? (result.expiresAt || now + fallbackDurationMs) : now + 20 * 60 * 1000;

    const numberDoc = {
      uid: order.uid,
      userEmail: order.email,
      provider: result.provider,       // 'smspva' (temp) ou 'smspva-rent' (mensuel)
      providerId: result.providerId,
      number: result.phone,
      country: order.countryCode,
      countryName: country.name,
      flag: country.flag,
      service,
      type: order.type,
      durationUnit: isMonthly ? duration.unit : null,
      durationCount: isMonthly ? duration.count : null,
      renewalsLeft: isMonthly ? 2 : 0,
      purchasedAt: now,
      expiresAt,
      price: order.amount,
      status: 'active'
    };

    await db.collection('numbers').add(numberDoc);
    await orderRef.update({ status: 'fulfilled', fulfilledAt: now });

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Erreur webhook FedaPay:', err);
    return { statusCode: 500, body: 'Erreur serveur.' };
  }
};
      
