export class MenuHandler {
  constructor(bot, sessions, actions = {}) {
    this.bot = bot;
    this.sessions = sessions;
    this.actions = actions; // { onDeposit, onExchange, onTransfer, onSend, onWithdraw }
  }

  keyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: '💰 Deposit' }, { text: '🔁 Exchange' }],
          [{ text: '💸 Transfer' }, { text: '📤 Send' }],
          [{ text: '🏧 Withdraw' }],
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
        '📱 <b>Afripay Finance Menu</b>',
        '',
        '🌟 <u>Available services:</u>',
        '',
        '💰 <b>Deposit</b>',
        '   • Deposit money to your account',
        '',
        '🔁 <b>Exchange</b>',
        '   • Exchange between different currencies',
        '',
        '💸 <b>Transfer</b>',
        '   • Bank transfer or beneficiary transfer',
        '',
        '📤 <b>Send</b>',
        '   • Send money to your contacts',
        '',
        '🏧 <b>Withdraw</b>',
        '   • Withdraw your funds',
        '',
        '👇 <i>Choose an option from the keyboard below:</i>'
      ].join('\n');
      await this.bot.sendMessage(chatId, text, { ...this.keyboard(), parse_mode: 'HTML' });
    });

    // Map button presses to action callbacks
    this.bot.on('message', (msg) => {
      const t = (msg.text || '').trim().toLowerCase();
      if (t === '💰 deposit' || t === 'deposit') {
        if (this.actions.onDeposit) return this.actions.onDeposit(msg);
        return this.bot.sendMessage(msg.chat.id, '🚧 <b>Feature in development</b>\n\n⚙️ This feature will be available soon!\n\n🔜 Return to menu: /menu', { parse_mode: 'HTML' });
      }
      if (t === '🔁 exchange' || t === 'exchange') {
        if (this.actions.onExchange) return this.actions.onExchange(msg);
        return this.bot.sendMessage(msg.chat.id, '🚧 <b>Feature in development</b>\n\n⚙️ This feature will be available soon!\n\n🔜 Return to menu: /menu', { parse_mode: 'HTML' });
      }
      if (t === '💸 transfer' || t === 'transfer') {
        if (this.actions.onTransfer) return this.actions.onTransfer(msg);
        return this.bot.sendMessage(msg.chat.id, '🚧 <b>Feature in development</b>\n\n⚙️ This feature will be available soon!\n\n🔜 Return to menu: /menu', { parse_mode: 'HTML' });
      }
      if (t === '📤 send' || t === 'send') {
        if (this.actions.onSend) return this.actions.onSend(msg);
        return this.bot.sendMessage(msg.chat.id, '🚧 <b>Feature in development</b>\n\n⚙️ This feature will be available soon!\n\n🔜 Return to menu: /menu', { parse_mode: 'HTML' });
      }
      if (t === '🏧 withdraw' || t === 'withdraw') {
        if (this.actions.onWithdraw) return this.actions.onWithdraw(msg);
        return this.bot.sendMessage(msg.chat.id, '🚧 <b>Feature in development</b>\n\n⚙️ This feature will be available soon!\n\n🔜 Return to menu: /menu', { parse_mode: 'HTML' });
      }
    });
  }
}
