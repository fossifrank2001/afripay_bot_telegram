import express from 'express';
import { config } from './config.js';
import { BotApp } from './core/BotApp.js';

// Global error handlers to avoid crashing on transient network errors (e.g., ECONNRESET)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[global] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[global] Uncaught Exception:', err);
});

// Initialize bot app (node-telegram-bot-api with polling inside)
const appBot = new BotApp();
appBot.register();

// Basic Express server for health checks and future webhooks
const app = express();
app.use(express.json());

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'afripay-telegram-bot', polling: true });
});

app.listen(config.PORT, () => {
  console.log(`HTTP server listening on port ${config.PORT}`);
  console.log('Telegram bot polling started.');
});
