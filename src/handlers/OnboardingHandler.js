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
      `👋 <b>Hello ${name}!</b>`,
      '',
      `🎉 Welcome to <b>Afripay Finance</b>, your modern banking service connected to <u>Genius-Wallet</u>.`,
      '',
      `💼 <b>What you can do:</b>`,
      `   💰 Deposit money`,
      `   🔁 Exchange currencies`,
      `   📤 Send money`,
      `   🏧 Withdraw funds`,
      '',
      `🔐 <b>Do you already have an account?</b>`
    ].join('\n');
    await this.bot.sendMessage(chatId, welcome, { ...this.keyboard(), parse_mode: 'HTML' });

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
    await this.bot.sendMessage(chatId, '📧 <b>Login to your account</b>\n\nPlease enter your <u>email address</u>:', { parse_mode: 'HTML' });
    this.bot.once('message', async (emailMsg) => {
      const email = (emailMsg.text || '').trim();
      if (!/^.+@.+\..+$/.test(email)) {
        await this.bot.sendMessage(chatId, `❌ <b>Invalid email</b>\n\nℹ️ Please run /login to try again.`, { parse_mode: 'HTML' });
        return;
      }
      await this.bot.sendMessage(chatId, '🔒 <b>Security</b>\n\nNow, enter your <u>password</u>:', { parse_mode: 'HTML' });
      this.bot.once('message', async (pwdMsg) => {
        const password = (pwdMsg.text || '').trim();
        if (!password) {
          await this.bot.sendMessage(chatId, `❌ <b>Empty password</b>\n\nℹ️ Please run /login to try again.`, { parse_mode: 'HTML' });
          return;
        }
        // Attempt login
        const res = await this.auth.login(chatId, { email, password });
        if (res?.error) {
          await this.bot.sendMessage(chatId, `❌ <b>Login failed</b>\n\n<i>${res.error}</i>\n\n🔄 Try again: /login`, { parse_mode: 'HTML' });
          return;
        }
        const user = this.sessions.get(chatId)?.auth?.user;
        await this.bot.sendMessage(chatId, `✅ <b>Login successful!</b>\n\n👤 Logged in as <b>${user?.name || email}</b>\n\n📱 Type /menu to see available services.`, { parse_mode: 'HTML' });
      });
    });
  }

  async requestContactForNoAccount(msg) {
    const chatId = msg.chat.id;
    // Snapshot profile for audit
    try { await this.botLog?.storeSystem(chatId, 'no_account_start', { from: msg.from, chat: msg.chat }); } catch {}

    const noAccountMsg = [
      '🆕 <b>Account Creation</b>',
      '',
      '👋 Welcome to Afripay!',
      '',
      '📋 To create your account, we need:',
      '   📱 Your phone number',
      '   👤 Your profile information',
      '   📧 Your email address',
      '',
      '🔐 <b>Rest assured:</b> Your data is <u>secure</u> and protected.',
      '',
      '👇 Click the button below to share your contact:'
    ].join('\n');
    
    await this.bot.sendMessage(chatId, noAccountMsg, {
      reply_markup: {
        keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
      parse_mode: 'HTML'
    });

    this.bot.once('message', async (m) => {
      if (!m.contact || String(m.contact.user_id) !== String(m.from?.id)) {
        try { await this.botLog?.storeSystem(chatId, 'contact_not_shared_or_mismatch', { received: m }); } catch {}
        await this.bot.sendMessage(chatId, '⚠️ <b>Contact not shared</b>\n\n❌ We didn\'t receive your contact.\n\n🔄 Please try again with /noaccount.', { parse_mode: 'HTML' });
        return;
      }

      const phone = m.contact.phone_number;
      const firstName = m.contact.first_name || m.from?.first_name || '';
      const lastName = m.contact.last_name || m.from?.last_name || '';
      const username = m.from?.username ? `@${m.from.username}` : '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || username || 'Telegram User';

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
        '✅ <b>Information received!</b>',
        '',
        '📋 <u>Summary of your information:</u>',
        `   👤 <b>Name:</b> ${displayName}`,
        `   📱 <b>Phone:</b> ${phone}`,
        username ? `   🆔 <b>Username:</b> ${username}` : null,
        '',
        '🔐 <b>Confirmation required</b>',
        '',
        '⚡ Do you confirm the use of this information to create your Afripay account?'
      ].filter(Boolean).join('\n');

      await this.bot.sendMessage(chatId, summary, {
        reply_markup: {
          keyboard: [[{ text: '✅ I approve' }], [{ text: '❌ Cancel' }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
        parse_mode: 'HTML'
      });

      this.bot.once('message', async (c) => {
        const t = (c.text || '').toLowerCase();
        if (!t.includes('approve')) {
          try { await this.botLog?.storeSystem(chatId, 'no_account_consent_denied'); } catch {}
          await this.bot.sendMessage(chatId, '🚫 <b>Registration cancelled</b>\n\n😊 No problem! You can start over anytime with /noaccount.', { parse_mode: 'HTML' });
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
    const emailMsg = [
      '📧 <b>Step 2/3: Email Address</b>',
      '',
      '✉️ Please enter your <u>email address</u>:',
      '',
      '💡 <i>This address will be used to log in and receive important notifications.</i>'
    ].join('\n');
    
    await this.bot.sendMessage(chatId, emailMsg, { parse_mode: 'HTML' });
    this.bot.once('message', async (em) => {
      const email = (em.text || '').trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailOk) {
        try { await this.botLog?.storeSystem(chatId, 'register_email_invalid', { input: em.text }); } catch {}
        await this.bot.sendMessage(chatId, '❌ <b>Invalid email</b>\n\n⚠️ The email format is not correct.\n\n🔄 Please start over with /noaccount.', { parse_mode: 'HTML' });
        return;
      }
      const session = this.sessions.get(chatId) || {};
      session.noAccount = { ...(session.noAccount || {}), email };
      this.sessions.set(chatId, session);
      await this.askRegistrationPassword(chatId);
    });
  }

  async askRegistrationPassword(chatId) {
    const passwordMsg = [
      '🔒 <b>Step 3/3: Password</b>',
      '',
      '🔐 Choose a <u>secure password</u>:',
      '',
      '📋 <b>Requirements:</b>',
      '   • Minimum <b>6 characters</b>',
      '   • Easy for you to remember',
      '   • Hard for others to guess',
      '',
      '💡 <i>Tip: Use a mix of letters and numbers</i>'
    ].join('\n');
    
    await this.bot.sendMessage(chatId, passwordMsg, { parse_mode: 'HTML' });
    this.bot.once('message', async (pm) => {
      const pass = (pm.text || '').trim();
      if (pass.length < 6) {
        try { await this.botLog?.storeSystem(chatId, 'register_password_too_short'); } catch {}
        await this.bot.sendMessage(chatId, '❌ <b>Password too short</b>\n\n⚠️ Password must contain at least <b>6 characters</b>.\n\n🔄 Please start over with /noaccount.', { parse_mode: 'HTML' });
        return;
      }
      await this.bot.sendMessage(chatId, '🔁 <b>Confirmation</b>\n\nPlease <u>confirm your password</u>:', { parse_mode: 'HTML' });
      this.bot.once('message', async (cm) => {
        const confirm = (cm.text || '').trim();
        if (confirm !== pass) {
          try { await this.botLog?.storeSystem(chatId, 'register_password_mismatch'); } catch {}
          await this.bot.sendMessage(chatId, '❌ <b>Passwords don\'t match</b>\n\n⚠️ The two passwords don\'t match.\n\n🔄 Please start over with /noaccount.', { parse_mode: 'HTML' });
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

    await this.bot.sendMessage(chatId, '⏳ <b>Creating your account...</b>\n\n⚙️ Please wait a moment.', { parse_mode: 'HTML' });
    try {
      const res = await this.auth.registerUser(chatId, payload);
      if (res?.error) {
        try { await this.botLog?.storeSystem(chatId, 'register_failed', { error: res.error, payload: { ...payload, password: '***' } }); } catch {}
        await this.bot.sendMessage(chatId, `❌ <b>Registration failed</b>\n\n<i>${res.error}</i>\n\n🔄 Please try again later.`, { parse_mode: 'HTML' });
        return;
      }
      try { await this.botLog?.storeSystem(chatId, 'register_success', { user: res.user || res.response?.user || null }); } catch {}
      
      const successMsg = [
        '🎉 <b>Congratulations!</b>',
        '',
        '✅ Your <b>Afripay</b> account has been created successfully!',
        '',
        '🔓 You are now <u>logged in</u>.',
        '',
        '📱 <b>Next steps:</b>',
        '   • Type /menu to see all services',
        '   • Start using Afripay',
        '',
        '💡 <i>Welcome to the Afripay family! 🚀</i>'
      ].join('\n');
      
      await this.bot.sendMessage(chatId, successMsg, { parse_mode: 'HTML' });
    } catch (e) {
      try { await this.botLog?.storeSystem(chatId, 'register_exception', { error: e?.message }); } catch {}
      await this.bot.sendMessage(chatId, '❌ <b>System error</b>\n\n⚠️ An error occurred during registration.\n\n🔄 Please try again later.', { parse_mode: 'HTML' });
    }
  }
}
