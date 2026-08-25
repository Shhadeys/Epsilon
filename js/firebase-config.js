// Fill this in with your own Firebase project's config to enable Chat.
//
// How to get these values:
//   1. Go to https://console.firebase.google.com and create a free project.
//   2. In the project, add a Web App (</> icon) -- this gives you the config below.
//   3. Enable Authentication -> Sign-in method -> Email/Password.
//   4. Enable Firestore Database (production mode is fine).
//   5. In Firestore -> Rules, paste the contents of firestore.rules from this repo and publish.
//
// These values are public identifiers, not secrets -- they are safe to commit and to ship
// in client-side code. What actually protects chat data is firestore.rules (step 5 above),
// which only lets a signed-in user read/write the public wall, their own DMs, and rooms
// they've joined.
window.FIREBASE_CONFIG = {
    apiKey: "AIzaSyA8h3hR7ufrADUdQ8E9zvsLxxsMraUATx4",
    authDomain: "epsilon-ea40a.firebaseapp.com",
    projectId: "epsilon-ea40a",
    storageBucket: "epsilon-ea40a.firebasestorage.app",
    messagingSenderId: "868938663584",
    appId: "1:868938663584:web:6f260f30d28b410647abc5",
};
