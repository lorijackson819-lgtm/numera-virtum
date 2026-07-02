# Numera Virtum — Guide de mise en ligne

Ce dossier contient tout le site : le front (index.html) et le backend sécurisé
(netlify/functions). Tu n'as **rien à coder** : juste à créer 2 comptes gratuits
(Firebase, déjà as FedaPay/SMSPVA) et coller quelques clés.

## Étape 1 — Créer le projet Firebase (gratuit, 5 min)

1. Va sur https://console.firebase.google.com → "Ajouter un projet" → nomme-le (ex: numera-virtum).
2. Dans le menu de gauche : **Authentication** → onglet "Sign-in method" → active :
   - "E-mail/Mot de passe"
   - "Google"
3. Dans le menu de gauche : **Firestore Database** → "Créer une base de données" → mode production → choisis une région proche (ex: europe-west).
4. Toujours dans Firestore, va dans l'onglet **Règles** et remplace par :
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if false;
       }
     }
   }
   ```
   (Personne ne doit pouvoir lire/écrire Firestore directement depuis le navigateur —
   seules tes fonctions Netlify y accèdent, avec les droits admin.)

5. **Récupérer la config web (clés publiques)** :
   - Icône ⚙️ → "Paramètres du projet" → en bas, "Vos applications" → "</>" (Web)
   - Donne un nom, clique "Enregistrer l'application"
   - Copie l'objet `firebaseConfig` affiché, et colle-le dans le fichier **firebase-config.js** à la racine du projet (remplace les "REMPLACE_MOI").

6. **Récupérer la clé de service (secrète, pour le backend)** :
   - ⚙️ → "Paramètres du projet" → onglet "Comptes de service"
   - Clique "Générer une nouvelle clé privée" → un fichier .json se télécharge
   - Garde ce fichier précieusement, on s'en sert à l'étape 3 (ne JAMAIS le mettre dans le dossier du site).

## Étape 2 — Déployer sur Netlify

1. Connecte-toi sur https://app.netlify.com
2. "Add new site" → "Deploy manually" → fais glisser **tout le dossier** numera-virtum (celui qui contient index.html et netlify/) dans la zone de dépôt.
3. Netlify te donne une URL du style `https://ton-site-1234.netlify.app`. Note-la.

## Étape 3 — Configurer les clés secrètes dans Netlify

Sur le dashboard Netlify de ton site : **Site configuration → Environment variables → Add a variable**.
Ajoute ces 3 variables :

| Nom de la variable | Valeur |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Le contenu **entier** du fichier .json téléchargé à l'étape 1.6, collé tel quel (tout sur une ligne, Netlify gère ça) |
| `FEDAPAY_SECRET_KEY` | Ta clé secrète FedaPay (dashboard FedaPay → Développeurs → Clé API → "Clé secrète", commence par `sk_live_` ou `sk_sandbox_`) |
| `SMSPVA_API_KEY` | Ta clé API SMSPVA |

Une fois ajoutées, va dans **Deploys** → "Trigger deploy" → "Deploy site" pour que les fonctions prennent en compte les clés.

## Étape 4 — Configurer le webhook FedaPay

C'est l'étape qui empêche qu'on puisse "tricher" un paiement.

1. Dashboard FedaPay → Développeurs → Webhooks → "Ajouter un webhook"
2. URL à coller : `https://ton-site-1234.netlify.app/.netlify/functions/fedapay-webhook`
3. Événement à écouter : `transaction.approved` (ou "tous les évènements" si pas de choix fin)

## Étape 5 — Tester

1. Ouvre ton site, crée un compte (email ou Google).
2. Choisis un pays, clique payer → tu es redirigé vers FedaPay.
3. Paye en mode test/sandbox d'abord si possible.
4. Tu reviens sur le site, et après quelques secondes le numéro apparaît dans "Mes numéros".

## Recharge SMSPVA via Monniz

Ça reste un geste manuel de ta part (toi qui recharges ton compte SMSPVA avec ta carte
virtuelle Monniz, comme avant) — rien à automatiser ici, le site achète juste des
numéros tant qu'il y a du solde sur ton compte SMSPVA.

## En cas de souci

- Onglet **Functions** du dashboard Netlify → clique sur une fonction → "Logs" : tu y verras les erreurs précises (clé manquante, mauvais format JSON, etc.)
- Erreur la plus fréquente au démarrage : le contenu de `FIREBASE_SERVICE_ACCOUNT` mal collé (assure-toi de copier-coller TOUT le fichier .json, accolades comprises).
