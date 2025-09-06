# Afripay Telegram Bot (Genius-Wallet)

Un bot Telegram (Node.js + Express) qui consomme l'API Laravel de Genius-Wallet pour offrir des opérations bancaires via Telegram.

## Objectifs
- Automatiser: solde, historique, transfert (MVP), extensible vers dépôts/retraits, crypto.
- Démarrer rapidement via polling, préparer le support webhook pour la prod.
- Sécurité: Auth Bearer dédiée au bot, validation stricte, HTTPS uniquement en prod.

## Architecture
```
Utilisateur → Telegram → Bot (Node.js/Express) → API Laravel → DB/Business
```
- Identification utilisateur: `telegram_chat_id` mappé à un `user` côté Laravel.
- Auth bot → API Laravel: `Authorization: Bearer <BOT_API_KEY>`.

## Prérequis
- Node.js >= 18 (fetch natif).
- Un bot Telegram créé via @BotFather (récupérer `TELEGRAM_BOT_TOKEN`).
- URL de l'API Laravel et Token d'accès du bot.

## Configuration
Créez un fichier `.env` à partir de `.env.example`:
```
TELEGRAM_BOT_TOKEN=...
LARAVEL_API_URL=https://votre-api.com/api
LARAVEL_BOT_API_KEY=...
PORT=3000
```

## Installation et Lancement
```
npm install
npm run start
```
- L'application démarre le bot en mode polling et expose `/healthz`.

## Commandes (MVP)
- `/start` – Message d'accueil et menu de base.
- `/solde` – Appelle `POST /balance` et affiche le solde.
- `/historique` – Appelle `POST /transactions` et affiche 5 dernières transactions.
- `/transfert` – Flow guidé: bénéficiaire → montant → exécution via `POST /transfer`.

## Intégration Laravel (attendue)
- Endpoints sécurisés par Bearer:
  - `POST /balance` → `{ balance: number }`
  - `POST /transactions` → `{ transactions: Array<{ date, type, amount }> }`
  - `POST /transfer` → `{ ok: true }` ou `{ error: string }`
- Chaque requête inclut: `{ telegram_chat_id, ... }`.
- Mapping `telegram_chat_id` ⇄ `user` géré côté Laravel (migration + service).

## Sécurité
- Ne jamais logger tokens/données sensibles.
- Valider les entrées: numéros, montants, formats.
- Toujours utiliser HTTPS en prod pour appeler l'API Laravel.

## Roadmap
1) MVP local (polling): `/start`, `/solde` (mock → réel), `/historique`, `/transfert`.
2) Auth et erreurs propres (timeouts, messages utilisateur clairs).
3) Tests locaux et cas d'erreur API.
4) Déploiement (Railway/Heroku/VPS) + variables d'env.
5) Améliorations: confirmations de transfert, claviers Telegram, logs structurés.
6) Préparer webhook (route Express protégée + setWebhook côté Telegram si nécessaire).
7) Phase WhatsApp (Cloud API / Provider) après stabilisation.

## Déploiement
- Fournir les variables d'environnement en prod.
- Lancer via `node src/index.js` (ou un process manager type PM2/systemd).
- Assurer que l'instance locale est arrêtée (pour éviter les doublons de polling).

## Développement
- Les handlers de commandes se trouvent dans `src/index.js`.
- Helper d'appel API: `callLaravelAPI(endpoint, chatId, method, body)`.
- Ajoutez de nouvelles commandes en suivant le même pattern.
