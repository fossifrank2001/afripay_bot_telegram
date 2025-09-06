export class OnboardingHandler {
  constructor(bot, sessions, authService) {
    this.bot = bot;
    this.sessions = sessions;
    this.auth = authService;
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
      const text = (reply.text || '').toLowerCase();
      if (text.includes('new')) {
        const link = this.auth.getRegistrationLink();
        await this.bot.sendMessage(chatId, `Great! Please register here and come back to the chat: ${link}`);
        await this.bot.sendMessage(chatId, `When you are done, send /login to continue.`);
      } else {
        await this.beginLogin({ chat: { id: chatId } });
      }
    });
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
}
