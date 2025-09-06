import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { SessionStore } from './SessionStore.js';
import { AuthService } from '../services/AuthService.js';
import { callLaravelAPI } from '../services/api.js';
import { OnboardingHandler } from '../handlers/OnboardingHandler.js';
import { MenuHandler } from '../handlers/MenuHandler.js';
import { DepositHandler } from '../handlers/DepositHandler.js';

export class BotApp {
  constructor() {
    this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
    this.sessions = new SessionStore();

    // Services
    this.authService = new AuthService(this.sessions);

    // Handlers
    this.onboarding = new OnboardingHandler(this.bot, this.sessions, this.authService);
    this.deposit = new DepositHandler(this.bot, this.sessions, this.authService);

    // Menu receives action callbacks so it can call handlers directly
    this.menu = new MenuHandler(this.bot, this.sessions, {
      onDeposit: (msg) => this.deposit.start(msg),
      onExchange: (msg) => this.bot.sendMessage(msg.chat.id, 'Fonctionnalité en cours d\'implémentation.'),
      onSend: (msg) => this.bot.sendMessage(msg.chat.id, 'Fonctionnalité en cours d\'implémentation.'),
      onWithdraw: (msg) => this.bot.sendMessage(msg.chat.id, 'Fonctionnalité en cours d\'implémentation.'),
    });
  }

  register() {
    // Onboarding
    this.onboarding.register();

    // Main menu and generic commands
    this.menu.register();

    // Deposit flow command in case user types /deposit manually
    this.bot.onText(/\/deposit/, (msg) => this.deposit.start(msg));

    // Balance (optional)
    this.bot.onText(/\/solde/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendChatAction(chatId, 'typing');
      const session = this.sessions.get(chatId);
      const data = await callLaravelAPI('/user/balance', chatId, 'POST', {}, { session });
      if (data?.error) return this.bot.sendMessage(chatId, `❌ Désolé: ${data.error}`);
      return this.bot.sendMessage(chatId, `💳 Votre solde actuel est de ${data.balance ?? 'N/A'}.`);
    });

    // History (optional)
    this.bot.onText(/\/historique/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendChatAction(chatId, 'typing');
      const session = this.sessions.get(chatId);
      const data = await callLaravelAPI('/user/transactions', chatId, 'POST', {}, { session });
      if (data?.error) return this.bot.sendMessage(chatId, `❌ Erreur: ${data.error}`);
      const list = (data.transactions || []).slice(0, 5).map(t => `▫️ ${t.date}: ${t.type} de ${t.amount}`).join('\n');
      return this.bot.sendMessage(chatId, list || 'Aucune transaction trouvée.');
    });
  }
}
