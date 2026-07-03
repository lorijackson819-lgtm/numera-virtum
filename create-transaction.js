// netlify/functions/create-transaction.js
// Le front appelle cette fonction pour démarrer un paiement.
// La clé SECRÈTE FedaPay reste ici, côté serveur, jamais dans le navigateur.

const fetch = require('node-fetch');
const { db, requireUser } = require('./_firebase');

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_API = 'https://api.fedapay.com/v1';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Méthode non autorisée.' };
  }

  try {
    const user = await requireUser(event);
    const body = JSON.parse(event.body || '{}');
    const { countryCode, type, renewNumberId } = body;

    if (!countryCode || (type !== 'temp' && type !== 'monthly')) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Paramètres invalides.' }) };
    }

    const { COUNTRIES } = require('./_countries');
    const country = COUNTRIES.find(c => c.code === countryCode);
    if (!country) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Pays inconnu.' }) };
    }
    const amount = type === 'monthly' ? country.monthlyPrice : country.tempPrice;

    const txRes = await fetch(`${FEDAPAY_API}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: `Numéro ${type === 'monthly' ? 'mensuel' : 'temporaire'} ${country.name}`,
        amount,
        currency: { iso: 'XOF' },
        customer: { email: user.email }
      })
    });
    const txData = await txRes.json();
    const transactionId = txData?.id || txData?.['v1/transaction']?.id || txData?.v1_transaction?.id;
    if (!txRes.ok || !transactionId) {
      console.log('FEDAPAY_TX_ERROR', txRes.status, JSON.stringify(txData));
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: 'Erreur création paiement FedaPay.',
          details: txData
        })
      };
    }

    const tokenRes = await fetch(`${FEDAPAY_API}/transactions/${transactionId}/token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}` }
    });
    const tokenData = await tokenRes.json();
    const paymentUrl = tokenData?.url || tokenData?.token?.url || tokenData?.['v1/token']?.url;
    if (!paymentUrl) {
      console.log('FEDAPAY_TOKEN_ERROR', tokenRes.status, JSON.stringify(tokenData));
      return { statusCode: 502, body: JSON.stringify({ error: 'Erreur génération lien de paiement.' }) };
    }

    await db.collection('pendingOrders').doc(String(transactionId)).set({
      uid: user.uid,
      email: user.email,
      countryCode,
      type,
      amount,
      renewNumberId: renewNumberId || null,
      status: 'pending',
      createdAt: Date.now()
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ paymentUrl, transactionId })
    };

  } catch (err) {
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ error: err.message || 'Erreur serveur.' })
    };
  }
};
