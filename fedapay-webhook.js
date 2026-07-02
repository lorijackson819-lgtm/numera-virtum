// netlify/functions/fedapay-webhook.js
// FedaPay appelle CETTE URL automatiquement quand une transaction change de statut.
// On ne fait JAMAIS confiance à ce que dit le navigateur du client : on revérifie
// le statut du paiement directement auprès de l'API FedaPay avant d'acheter quoi
// que ce soit sur SMSPVA.
//
// À configurer dans ton dashboard FedaPay :
// URL du webhook = https://TON-SITE.netlify.app/.netlify/functions/fedapay-webhook

const fetch = require('node-fetch');
const { db } = require('./_firebase');
const { COUNTRIES, COUNTRY_SMSPVA } = require('./_countries');

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
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

  // FedaPay envoie l'id de transaction dans l'évènement webhook
  const transactionId = payload?.entity?.id || payload?.data?.id || payload?.id;
  if (!transactionId) {
    return { statusCode: 400, body: 'Transaction id manquant.' };
  }

  try {
    // 1) Re-vérification du statut réel auprès de FedaPay (jamais via le payload seul)
    const verifyRes = await fetch(`${FEDAPAY_API}/transactions/${transactionId}`, {
      headers: { 'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();
    const status = verifyData?.['v1/transaction']?.status;

    if (status !== 'approved') {
      // Paiement pas (encore) confirmé : on ne fait rien, FedaPay réessaiera si besoin.
      return { statusCode: 200, body: 'Statut non approuvé, ignoré.' };
    }

    const orderRef = db.collection('pendingOrders').doc(String(transactionId));
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return { statusCode: 404, body: 'Commande introuvable.' };
    }
    const order = orderSnap.data();

    // Empêche un double-traitement si FedaPay renvoie le webhook plusieurs fois
    if (order.status === 'fulfilled') {
      return { statusCode: 200, body: 'Déjà traité.' };
    }

    const country = COUNTRIES.find(c => c.code === order.countryCode);
    const countryKey = COUNTRY_SMSPVA[order.countryCode];
    if (!country || !countryKey) {
      await orderRef.update({ status: 'failed', error: 'Pays inconnu côté SMSPVA' });
      return { statusCode: 200, body: 'Pays inconnu.' };
    }

    // Cas RENOUVELLEMENT : on prolonge un numéro existant, pas besoin de rappeler SMSPVA
    if (order.renewNumberId) {
      const numRef = db.collection('numbers').doc(order.renewNumberId);
      const numSnap = await numRef.get();
      if (numSnap.exists && numSnap.data().uid === order.uid && numSnap.data().renewalsLeft > 0) {
        await numRef.update({
          expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
          renewalsLeft: numSnap.data().renewalsLeft - 1
        });
      }
      await orderRef.update({ status: 'fulfilled', fulfilledAt: Date.now() });
      return { statusCode: 200, body: 'OK (renouvellement)' };
    }

    // 2) Achat du numéro auprès de SMSPVA — la clé API ne quitte jamais ce serveur
    const smsRes = await fetch(
      `https://smspva.com/priemnik.php?metod=get_service&country=${countryKey}&service=opt18&apikey=${SMSPVA_API_KEY}`
    );
    const smsData = await smsRes.json();

    if (!smsData.phone || smsData.response !== '1') {
      await orderRef.update({ status: 'failed', error: smsData.msg || 'Aucun numéro disponible' });
      // Idéalement : déclencher ici un remboursement FedaPay automatique.
      return { statusCode: 200, body: 'Échec attribution SMSPVA.' };
    }

    const now = Date.now();
    const isMonthly = order.type === 'monthly';
    const expiresAt = isMonthly ? now + 30 * 24 * 3600 * 1000 : now + 20 * 60 * 1000;

    const numberDoc = {
      uid: order.uid,
      userEmail: order.email,
      smspvaId: smsData.id,
      number: smsData.phone,
      country: order.countryCode,
      countryName: country.name,
      flag: country.flag,
      type: order.type,
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
