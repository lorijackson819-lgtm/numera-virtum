// firebase-config.js
// Ces identifiants sont les paramètres PUBLICS de ton projet Firebase
// (pas des secrets : ils sont conçus pour être dans le navigateur).
// Va dans la console Firebase > Paramètres du projet > Tes applications > Config,
// et remplace les valeurs ci-dessous par les tiennes.

const firebaseConfig = {
  apiKey: "AIzaSyAIvyb7Cvozy4grtLIq_ybKkhGNGt5Qfv8",
  authDomain: "numeravirtum.firebaseapp.com",
  projectId: "numeravirtum",
  storageBucket: "numeravirtum.firebasestorage.app",
  messagingSenderId: "5072506920",
  appId: "1:5072506920:web:1d41ca7652364d4602cf05"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
