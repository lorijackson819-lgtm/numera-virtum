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

    // Le prix est lu côté serveur (fichier countries.js), jamais fait confiance au front,
    // pour empêcher un client de modifier le prix avant l'envoi.
    const { COUNTRIES } = require('./_countries');
    const country = COUNTRIES.find(c => c.code === countryCode);
    if (!country) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Pays inconnu.' }) };
    }
    const amount = type === 'monthly' ? country.monthlyPrice : country.tempPrice;

    // 1) Création de la transaction FedaPay côté serveur
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
    // La réponse de FedaPay place l'id directement à la racine (txData.id),
    // pas dans un sous-objet "v1_transaction".
    const transactionId = txData?.id || txData?.v1_transaction?.id;
    if (!txRes.ok || !transactionId) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: 'Erreur création paiement FedaPay.',
          details: txData
        })
      };
    }

    // 2) Génération du lien de paiement (token)
    const tokenRes = await fetch(`${FEDAPAY_API}/transactions/${transactionId}/token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}` }
    });
    const tokenData = await tokenRes.json();
    const paymentUrl = tokenData?.url;
    if (!paymentUrl) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Erreur génération lien de paiement.' }) };
    }

    // 3) On enregistre une "commande en attente" dans Firestore.
    // C'est CE document, écrit côté serveur, qui sera utilisé par le webhook
    // pour savoir quoi acheter sur SMSPVA une fois le paiement confirmé.
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
  
