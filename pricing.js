// netlify/functions/pricing.js
// Module partagé : calcule le prix de vente (FCFA) à partir du prix/jour
// SMSPVA (USD) + une marge fixe. Utilisé par create-transaction.js et
// par get-availability.js (affichage du prix côté front).
//
// ⚠️ MARGE et TAUX modifiables ici uniquement — source unique de vérité,
// ne jamais recalculer ces valeurs ailleurs dans le code.

const MARGIN = 0.35;        // 35% de marge sur le prix coûtant SMSPVA
const USD_TO_FCFA = 575;    // taux fixe manuel — à réajuster périodiquement

// Convertit une unité de durée choisie par le client en nombre de jours,
// et en paramètres dtype/dcount attendus par SMSPVA rent.php (method=create).
// Les valeurs 'day'/'week'/'month' pour dtype sont celles vues dans l'UI SMSPVA
// (capture "Select rental period") — à reconfirmer côté doc si un appel échoue.
const UNIT_TO_DAYS = { day: 1, week: 7, month: 30 };
const ALLOWED_UNITS = ['day', 'week', 'month'];

function resolveDuration(unit, count) {
  const safeUnit = ALLOWED_UNITS.includes(unit) ? unit : 'month';
  const safeCount = Number.isInteger(count) && count > 0 ? count : 1;
  const durationDays = UNIT_TO_DAYS[safeUnit] * safeCount;
  return {
    unit: safeUnit,
    count: safeCount,
    durationDays,
    smspvaDtype: safeUnit,   // dtype attendu par rent.php?method=create
    smspvaDcount: safeCount  // dcount attendu par rent.php?method=create
  };
}

// pricePerDayUSD vient du cache Firestore (servicePricing), alimenté par
// refresh-availability.js. durationDays = nombre total de jours loués.
function calculatePrice(pricePerDayUSD, durationDays) {
  const costUSD = pricePerDayUSD * durationDays;
  const sellUSD = costUSD * (1 + MARGIN);
  return {
    costUSD: Number(costUSD.toFixed(2)),
    costFCFA: Math.round(costUSD * USD_TO_FCFA),
    sellUSD: Number(sellUSD.toFixed(2)),
    sellFCFA: Math.round(sellUSD * USD_TO_FCFA)
  };
}

module.exports = {
  MARGIN,
  USD_TO_FCFA,
  UNIT_TO_DAYS,
  ALLOWED_UNITS,
  resolveDuration,
  calculatePrice
};
