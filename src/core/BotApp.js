import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { SessionStore } from './SessionStore.js';
import { AuthService } from '../services/AuthService.js';
import { callLaravelAPI } from '../services/api.js';
import { OnboardingHandler } from '../handlers/OnboardingHandler.js';
import { MenuHandler } from '../handlers/MenuHandler.js';
import { DepositHandler } from '../handlers/DepositHandler.js';
import { ExchangeHandler } from '../handlers/ExchangeHandler.js';
import { TransferHandler } from '../handlers/TransferHandler.js';
import { BotLogService } from '../services/BotLogService.js';

export class BotApp {
  constructor() {
    this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
    this.sessions = new SessionStore();
    this._registered = false; // guard to prevent double registration

    // Log and survive polling errors (e.g., DNS, network)
    this.bot.on('polling_error', (err) => {
      console.error('[polling_error]', err?.code || '', err?.message || err);
    });
    this.bot.on('webhook_error', (err) => {
      console.error('[webhook_error]', err?.code || '', err?.message || err);
    });

    // Services
    this.authService = new AuthService(this.sessions);
    this.botLog = new BotLogService(this.sessions, 'telegram');

    // Monkey-patch sendMessage to log all outgoing bot questions/answers
    const originalSendMessage = this.bot.sendMessage.bind(this.bot);
    this.bot.sendMessage = async (chatId, text, options) => {
      try {
        // Ensure conversation exists before sending
        await this.botLog.upsertConversation(chatId);
        const sent = await originalSendMessage(chatId, text, options);
        // Record outgoing message with Telegram message_id
        const sentAt = sent.date ? new Date(sent.date * 1000).toISOString() : new Date().toISOString();
        await this.botLog.storeMessage(chatId, {
          direction: 'outgoing',
          message_type: 'text',
          content: text,
          payload: { options },
          external_message_id: String(sent.message_id),
          sent_at: sentAt,
        });
        return sent;
      } catch (e) {
        // Log the failure as a system event
        await this.botLog.storeSystem(chatId, 'sendMessage failed', { error: e?.message || String(e), text, options });
        throw e;
      }
    };

    // Handlers
    this.onboarding = new OnboardingHandler(this.bot, this.sessions, this.authService, this.botLog);
    this.deposit = new DepositHandler(this.bot, this.sessions, this.authService, this.botLog);
    this.exchange = new ExchangeHandler(this.bot, this.sessions, this.authService, this.botLog);
    this.transfer = new TransferHandler(this.bot, this.sessions, this.authService, this.botLog);

    // Menu receives action callbacks so it can call handlers directly
    this.menu = new MenuHandler(this.bot, this.sessions, {
      onDeposit: (msg) => this.deposit.start(msg),
      onExchange: (msg) => this.exchange.start(msg),
      onTransfer: (msg) => this.transfer.start(msg),
      onSend: (msg) => this.bot.sendMessage(msg.chat.id, 'Feature under implementation.'),
      onWithdraw: (msg) => this.bot.sendMessage(msg.chat.id, 'Feature under implementation.'),
    });
  }

  register() {
    if (this._registered) return; // avoid double-registering handlers
    this._registered = true;
    // Onboarding
    this.onboarding.register();

    // Main menu and generic commands
    this.menu.register();

    // deposit flow command in case user types /deposit manually
    this.bot.onText(/\/deposit/, (msg) => this.deposit.start(msg));

    // Exchange flow command
    this.bot.onText(/\/exchange/, (msg) => this.exchange.start(msg));

    // Transfer flow command
    this.bot.onText(/\/transfer/, (msg) => this.transfer.start(msg));

    // No account quick commands
    this.bot.onText(/\/(noaccount|sanscompte)/i, (msg) => this.onboarding.requestContactForNoAccount(msg));
    // Natural language: "I'm new", "I am new", "nouveau", "je n'ai pas de compte"
    this.bot.onText(/\b(i['’]?m new|i am new|new user|je suis nouveau|je n['’]ai pas de compte|sans compte)\b/i, (msg) => this.onboarding.requestContactForNoAccount(msg));

    // Record incoming user messages for conversation history
    this.bot.on('message', async (msg) => {
      try {
        const chatId = msg.chat.id;
        // Ensure conversation exists (binds user_id if logged)
        await this.botLog.upsertConversation(chatId);

        // Determine message type
        let message_type = 'text';
        if (Array.isArray(msg.photo) && msg.photo.length) message_type = 'image';
        else if (msg.document) message_type = 'file';
        else if (msg.sticker) message_type = 'image';

        const sentAt = msg.date ? new Date(msg.date * 1000).toISOString() : undefined;
        await this.botLog.storeMessage(chatId, {
          direction: 'incoming',
          message_type,
          content: msg.text || undefined,
          payload: msg,
          external_message_id: String(msg.message_id),
          sent_at: sentAt,
        });
      } catch (e) {
        // Log any unexpected failure to record
        const chatId = msg?.chat?.id;
        if (chatId) {
          await this.botLog.storeSystem(chatId, 'incoming log failed', { error: e?.message || String(e) });
        }
        console.error('[botLog] failed to record message', e?.message || e);
      }
    });

    // Balance (optional)
    this.bot.onText(/\/solde/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendChatAction(chatId, 'typing');
      const session = this.sessions.get(chatId);
      const data = await callLaravelAPI('/user/balance', chatId, 'POST', {}, { session });
      if (data?.error) return this.bot.sendMessage(chatId, `❌ Sorry: ${data.error}`);
      return this.bot.sendMessage(chatId, `💳 Your current balance is ${data.balance ?? 'N/A'}.`);
    });

    // History (optional)
    this.bot.onText(/\/historique/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendChatAction(chatId, 'typing');
      const session = this.sessions.get(chatId);
      const data = await callLaravelAPI('/user/transactions', chatId, 'POST', {}, { session });
      if (data?.error) return this.bot.sendMessage(chatId, `❌ Error: ${data.error}`);
      const list = (data.transactions || []).slice(0, 5).map(t => `▫️ ${t.date}: ${t.type} of ${t.amount}`).join('\n');
      return this.bot.sendMessage(chatId, list || 'No transactions found.');
    });
  }
}
