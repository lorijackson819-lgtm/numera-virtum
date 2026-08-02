// netlify/functions/create-transaction.js
// Le front appelle cette fonction pour démarrer un paiement.
// La clé SECRÈTE FedaPay reste ici, côté serveur, jamais dans le navigateur.

const fetch = require('node-fetch');
const { db, requireUser } = require('./_firebase');
const { resolveDuration, calculatePrice } = require('./pricing');

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_API = 'https://api.fedapay.com/v1';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Méthode non autorisée.' };
  }

  try {
    const user = await requireUser(event);
    const body = JSON.parse(event.body || '{}');
    const { countryCode, type, renewNumberId, service, durationUnit, durationCount } = body;

    if (!countryCode || (type !== 'temp' && type !== 'monthly')) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Paramètres invalides.' }) };
    }

    // Whitelist stricte : jamais faire confiance à une chaîne libre venant du
    // navigateur pour construire une URL d'appel API derrière (voir _providers.js).
    const ALLOWED_SERVICES = ['whatsapp', 'tiktok', 'telegram'];
    const chosenService = ALLOWED_SERVICES.includes(service) ? service : 'whatsapp';

    const { COUNTRIES } = require('./_countries');
    const country = COUNTRIES.find(c => c.code === countryCode);
    if (!country) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Pays inconnu.' }) };
    }

    // ─────────────────────────────────────────────────────────────────────
    // CALCUL DU PRIX
    // - "temp" : usage unique, prix fixe existant (country.tempPrice) — pas
    //   de notion de durée, on garde le comportement d'origine.
    // - "monthly" (= location, durée flexible jour/semaine/mois) : le prix
    //   est recalculé côté serveur à partir du prix/jour SMSPVA mis en cache
    //   par refresh-availability.js. JAMAIS fait confiance à un prix envoyé
    //   par le front, uniquement à durationUnit/durationCount + au cache.
    // ─────────────────────────────────────────────────────────────────────
    let amount;
    let duration = null;

    if (type === 'temp') {
      amount = country.tempPrice;
    } else {
      duration = resolveDuration(durationUnit, durationCount);

      const priceDoc = await db.collection('servicePricing')
        .doc(`${countryCode}_${chosenService}`).get();

      if (!priceDoc.exists) {
        return {
          statusCode: 409,
          body: JSON.stringify({ error: 'Prix indisponible pour ce pays/service pour le moment. Réessayez dans quelques minutes.' })
        };
      }

      const { pricePerDayUSD } = priceDoc.data();
      const { sellFCFA } = calculatePrice(pricePerDayUSD, duration.durationDays);
      amount = sellFCFA;
    }

    // 1) Création de la transaction FedaPay côté serveur
    const txRes = await fetch(`${FEDAPAY_API}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FEDAPAY_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: type === 'monthly'
          ? `Numéro ${country.name} — ${chosenService} — ${duration.count} ${duration.unit}(s)`
          : `Numéro temporaire ${country.name} — ${chosenService}`,
        amount,
        currency: { iso: 'XOF' },
        customer: { email: user.email }
      })
    });
    const txData = await txRes.json();
    if (!txRes.ok || !txData.v1_transaction) {
      console.error('FedaPay erreur:', JSON.stringify(txData));
      return { statusCode: 502, body: JSON.stringify({ error: 'Erreur FedaPay: ' + (txDat.message || JSON.stringify(txData)) }) };
    }
    const transactionId = txData.v1_transaction.id;

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
      service: chosenService,
      amount,
      // durationUnit/durationCount/durationDays : null pour "temp" (usage unique).
      // Pour "monthly", à lire par fedapay-webhook.js pour appeler
      // buySmspvaRent(countryCode, service, duration.smspvaDtype, duration.smspvaDcount)
      // ⚠️ fedapay-webhook.js n'a pas encore été mis à jour pour lire ces
      // champs — actuellement il appelle sans doute buySmspvaMonthly() en dur,
      // ce qui ignore la durée choisie. À corriger avant mise en prod.
      durationUnit: duration?.unit || null,
      durationCount: duration?.count || null,
      durationDays: duration?.durationDays || null,
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
             
