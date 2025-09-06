export class MenuHandler {
  constructor(bot, sessions, actions = {}) {
    this.bot = bot;
    this.sessions = sessions;
    this.actions = actions; // { onDeposit, onExchange, onSend, onWithdraw }
  }

  keyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: '💰 Deposit' }, { text: '🔁 Exchange' }],
          [{ text: '📤 Send' }, { text: '🏧 Withdraw' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    };
  }

  register() {
    this.bot.onText(/\/menu/, async (msg) => {
      const chatId = msg.chat.id;
      const text = [
        'Available Afripay services:',
        '1) 💰 Deposit',
        '2) 🔁 Exchange',
        '3) 📤 Send',
        '4) 🏧 Withdraw',
        '',
        'Choose an option from the keyboard below.'
      ].join('\n');
      await this.bot.sendMessage(chatId, text, this.keyboard());
    });

    // Map button presses to action callbacks
    this.bot.on('message', (msg) => {
      const t = (msg.text || '').trim().toLowerCase();
      if (t === '💰 deposit' || t === 'deposit') {
        if (this.actions.onDeposit) return this.actions.onDeposit(msg);
        return this.bot.sendMessage(msg.chat.id, 'Feature under implementation.');
      }
      if (t === '🔁 exchange' || t === 'exchange') {
        if (this.actions.onExchange) return this.actions.onExchange(msg);
        return this.bot.sendMessage(msg.chat.id, 'Feature under implementation.');
      }
      if (t === '📤 send' || t === 'send') {
        if (this.actions.onSend) return this.actions.onSend(msg);
        return this.bot.sendMessage(msg.chat.id, 'Feature under implementation.');
      }
      if (t === '🏧 withdraw' || t === 'withdraw') {
        if (this.actions.onWithdraw) return this.actions.onWithdraw(msg);
        return this.bot.sendMessage(msg.chat.id, 'Feature under implementation.');
      }
    });
  }
}
