import { callLaravelAPI } from '../services/api.js';

export class OnboardingHandler {
  constructor(bot, sessions, authService, botLog) {
    this.bot = bot;
    this.sessions = sessions;
    this.auth = authService;
    this.botLog = botLog;
  }

  keyboard() {
    return {
      reply_markup: {
        keyboard: [[{ text: "✅ I have an account" }], [{ text: '🆕 I\'m new' }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
  }

  register() {
    this.bot.onText(/\/start/, (msg) => this.start(msg));
    this.bot.onText(/\/login/, (msg) => this.beginLogin(msg));
    this.bot.onText(/\/noaccount/, (msg) => this.requestContactForNoAccount(msg));
  }

  async start(msg) {
    const chatId = msg.chat.id;
    const name = msg.from?.first_name || 'there';
    const welcome = [
      `👋 Hello ${name}!`,
      `Welcome to Afripay, the modern banking service connected to Genius‑Wallet.`,
      '',
      `Do you already have an account?`
    ].join('\n');
    await this.bot.sendMessage(chatId, welcome, this.keyboard());

    // Next message determines the path
    this.bot.once('message', async (reply) => {
      await this.handleNewUserBranch(chatId, reply);
    });
  }

  async handleNewUserBranch(chatId, reply) {
    const text = (reply.text || '').toLowerCase();
    if (text.includes('new')) {
      // Start the in-chat registration flow using Telegram contact & profile
      return this.requestContactForNoAccount({ chat: { id: chatId }, from: reply.from });
    }
    // Otherwise, continue the normal login
    return this.beginLogin({ chat: { id: chatId } });
  }

  async beginLogin(msg) {
    const chatId = msg.chat.id;
    await this.bot.sendMessage(chatId, 'Please enter your email address:');
    this.bot.once('message', async (emailMsg) => {
      const email = (emailMsg.text || '').trim();
      if (!/^.+@.+\..+$/.test(email)) {
        await this.bot.sendMessage(chatId, `Invalid email. Please run /login again.`);
        return;
      }
      await this.bot.sendMessage(chatId, 'Enter your password:');
      this.bot.once('message', async (pwdMsg) => {
        const password = (pwdMsg.text || '').trim();
        if (!password) {
          await this.bot.sendMessage(chatId, `Empty password. Please run /login again.`);
          return;
        }
        // Attempt login
        const res = await this.auth.login(chatId, { email, password });
        if (res?.error) {
          await this.bot.sendMessage(chatId, `❌ Login failed: ${res.error}. Try again: /login`);
          return;
        }
        const user = this.sessions.get(chatId)?.auth?.user;
        await this.bot.sendMessage(chatId, `✅ Logged in as ${user?.name || email}. Type /menu to see services.`);
      });
    });
  }

  async requestContactForNoAccount(msg) {
    const chatId = msg.chat.id;
    // Snapshot profile for audit
    try { await this.botLog?.storeSystem(chatId, 'no_account_start', { from: msg.from, chat: msg.chat }); } catch {}

    await this.bot.sendMessage(chatId, 'Vous n\'avez pas de compte. Partagez votre contact pour continuer :', {
      reply_markup: {
        keyboard: [[{ text: '📱 Partager mon numéro', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });

    this.bot.once('message', async (m) => {
      if (!m.contact || String(m.contact.user_id) !== String(m.from?.id)) {
        try { await this.botLog?.storeSystem(chatId, 'contact_not_shared_or_mismatch', { received: m }); } catch {}
        await this.bot.sendMessage(chatId, 'Aucun contact partagé. Veuillez réessayer avec /noaccount.');
        return;
      }

      const phone = m.contact.phone_number;
      const firstName = m.contact.first_name || m.from?.first_name || '';
      const lastName = m.contact.last_name || m.from?.last_name || '';
      const username = m.from?.username ? `@${m.from.username}` : '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || username || 'Utilisateur Telegram';

      // Log contact event
      try {
        await this.botLog?.storeMessage(chatId, {
          direction: 'incoming',
          message_type: 'system',
          content: 'User shared contact',
          payload: { contact: m.contact, from: m.from },
          external_message_id: String(m.message_id),
          sent_at: m.date ? new Date(m.date * 1000).toISOString() : undefined,
        });
      } catch {}

      const summary = [
        'Nous avons détecté les informations suivantes :',
        `• Nom: ${displayName}`,
        `• Téléphone: ${phone}`,
        username ? `• Nom d\'utilisateur: ${username}` : null,
      ].filter(Boolean).join('\n');

      await this.bot.sendMessage(chatId, summary + '\n\nConfirmez-vous l\'utilisation de ces informations pour créer votre compte ?', {
        reply_markup: {
          keyboard: [[{ text: '✅ J\'approuve' }], [{ text: '❌ Annuler' }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });

      this.bot.once('message', async (c) => {
        const t = (c.text || '').toLowerCase();
        if (!t.includes('approuve')) {
          try { await this.botLog?.storeSystem(chatId, 'no_account_consent_denied'); } catch {}
          await this.bot.sendMessage(chatId, 'Compris. Vous pourrez recommencer avec /noaccount.');
          return;
        }

        // Save in session and update conversation title
        const session = this.sessions.get(chatId) || {};
        session.noAccount = {
          phone,
          firstName,
          lastName,
          username: m.from?.username || null,
          from: m.from,
        };
        this.sessions.set(chatId, session);

        try {
          const title = displayName;
          await this.botLog?.upsertConversation(chatId, { title });
          await this.botLog?.storeSystem(chatId, 'no_account_consent_approved', { title, phone });
        } catch {}

        // Continue registration: ask email, then password
        await this.askRegistrationEmail(chatId);
      });
    });
  }

  async askRegistrationEmail(chatId) {
    await this.bot.sendMessage(chatId, 'Veuillez saisir votre email :');
    this.bot.once('message', async (em) => {
      const email = (em.text || '').trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailOk) {
        try { await this.botLog?.storeSystem(chatId, 'register_email_invalid', { input: em.text }); } catch {}
        await this.bot.sendMessage(chatId, 'Email invalide. Veuillez recommencer avec /noaccount.');
        return;
      }
      const session = this.sessions.get(chatId) || {};
      session.noAccount = { ...(session.noAccount || {}), email };
      this.sessions.set(chatId, session);
      await this.askRegistrationPassword(chatId);
    });
  }

  async askRegistrationPassword(chatId) {
    await this.bot.sendMessage(chatId, 'Choisissez un mot de passe (min. 6 caractères) :');
    this.bot.once('message', async (pm) => {
      const pass = (pm.text || '').trim();
      if (pass.length < 6) {
        try { await this.botLog?.storeSystem(chatId, 'register_password_too_short'); } catch {}
        await this.bot.sendMessage(chatId, 'Mot de passe trop court. Veuillez recommencer avec /noaccount.');
        return;
      }
      await this.bot.sendMessage(chatId, 'Confirmez votre mot de passe :');
      this.bot.once('message', async (cm) => {
        const confirm = (cm.text || '').trim();
        if (confirm !== pass) {
          try { await this.botLog?.storeSystem(chatId, 'register_password_mismatch'); } catch {}
          await this.bot.sendMessage(chatId, 'Les mots de passe ne correspondent pas. Veuillez recommencer avec /noaccount.');
          return;
        }
        // Ready to register
        await this.performRegistration(chatId, pass);
      });
    });
  }

  async performRegistration(chatId, password) {
    const session = this.sessions.get(chatId) || {};
    const data = session.noAccount || {};
    const payload = {
      first_name: data.firstName || undefined,
      last_name: data.lastName || undefined,
      username: data.username || undefined,
      phone: data.phone,
      email: data.email,
      password,
      password_confirmation: password,
      telegram_id: data.from?.id,
      telegram_username: data.username || undefined,
    };

    await this.bot.sendMessage(chatId, 'Création de votre compte, un instant…');
    try {
      const res = await this.auth.registerUser(chatId, payload);
      if (res?.error) {
        try { await this.botLog?.storeSystem(chatId, 'register_failed', { error: res.error, payload: { ...payload, password: '***' } }); } catch {}
        await this.bot.sendMessage(chatId, `❌ Échec de l\'inscription: ${res.error}`);
        return;
      }
      try { await this.botLog?.storeSystem(chatId, 'register_success', { user: res.user || res.response?.user || null }); } catch {}
      await this.bot.sendMessage(chatId, '✅ Votre compte a été créé avec succès. Vous êtes maintenant connecté. Tapez /menu pour commencer.');
    } catch (e) {
      try { await this.botLog?.storeSystem(chatId, 'register_exception', { error: e?.message }); } catch {}
      await this.bot.sendMessage(chatId, '❌ Une erreur est survenue pendant l\'inscription. Veuillez réessayer plus tard.');
    }
  }
}
