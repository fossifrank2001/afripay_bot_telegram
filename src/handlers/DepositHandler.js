import { callLaravelAPI } from '../services/api.js';

export class DepositHandler {
  constructor(bot, sessions, authService) {
    this.bot = bot;
    this.sessions = sessions;
    this.auth = authService;
  }

  register() {
    this.bot.onText(/\/deposit/, (msg) => this.start(msg));
  }

  async start(msg) {
    const chatId = msg.chat.id;
    const session = this.sessions.get(chatId);
    if (!session?.auth?.isAuthed) {
      await this.bot.sendMessage(chatId, 'Please login first with /login');
      return;
    }

    // Fetch wallets and recent deposits
    const data = await callLaravelAPI('/user/deposit', chatId, 'GET', {}, { session });
    if (data?.error) {
      return this.bot.sendMessage(chatId, `❌ Error: ${data.error}`);
    }

    const wallets = data?.response?.wallets || data?.wallets || [];
    const history = data?.response?.recent_deposits || data?.recent_deposits || [];

    session.deposit = {
      step: 'amount',
      wallets,
      history,
    };
    this.sessions.set(chatId, session);

    // Show last 3 deposit history items
    const last3 = history.slice(0, 3).map((h) => {
      const amount = h.amount;
      const method = h.method; // id only available
      const status = h.status;
      const date = h.created_at?.split('T')[0] || h.created_at || '';
      return `• ${amount} | method: ${method} | ${status} | ${date}`;
    }).join('\n');

    const histBlock = last3 ? `Last deposits:\n${last3}\n\n` : '';

    await this.bot.sendMessage(chatId, histBlock + 'Enter the amount to deposit (e.g., 10000). This amount will top up your balance in the selected wallet.');

    // Ask for amount
    this.bot.once('message', async (aMsg) => {
      const amount = parseFloat((aMsg.text || '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) {
        return this.bot.sendMessage(chatId, 'Invalid amount. Please run /deposit again.');
      }
      session.deposit.amount = amount;
      session.deposit.step = 'wallet';
      this.sessions.set(chatId, session);

      // Ask wallet selection (show all, but only XAF available for now)
      if (!wallets.length) {
        return this.bot.sendMessage(chatId, 'No wallets available on your account.');
      }
      const list = wallets.map((w, i) => `${i + 1}) ${w.code} - ${w.curr_name}`).join('\n');
      await this.bot.sendMessage(chatId, `Choose the wallet:\n${list}\n\nReply with the number (e.g., 1).`);

      this.bot.once('message', async (wMsg) => {
        const idx = parseInt((wMsg.text || '').trim(), 10) - 1;
        const chosen = wallets[idx];
        if (!chosen) {
          return this.bot.sendMessage(chatId, 'Invalid choice. Please run /deposit again.');
        }
        if ((chosen.code || '').toUpperCase() !== 'XAF') {
          await this.bot.sendMessage(chatId, `Wallet ${chosen.code} is not available for now. Only XAF is supported. Please run /deposit again.`);
          return;
        }
        session.deposit.wallet = chosen;
        session.deposit.step = 'gateway';
        this.sessions.set(chatId, session);

        // Fetch gateway methods for selected wallet
        const methodsRes = await callLaravelAPI('/user/gateway-methods', chatId, 'GET', { currency_id: String(chosen.id) }, { session });
        if (methodsRes?.error) {
          return this.bot.sendMessage(chatId, `❌ Payment methods error: ${methodsRes.error}`);
        }
        const methods = methodsRes?.response?.methods || methodsRes?.methods || [];
        if (!methods.length) {
          return this.bot.sendMessage(chatId, 'No payment methods available for this wallet.');
        }

        session.deposit.methods = methods;
        this.sessions.set(chatId, session);

        const listMethods = methods.map((m, i) => `${i + 1}) ${m.name} (${m.type})`).join('\n');
        await this.bot.sendMessage(chatId, `Select a payment method:\n${listMethods}\n\nReply with the number (e.g., 1).`);

        this.bot.once('message', async (mReply) => {
          const mIdx = parseInt((mReply.text || '').trim(), 10) - 1;
          const chosenMethod = methods[mIdx];
          if (!chosenMethod) {
            return this.bot.sendMessage(chatId, 'Invalid choice. Please run /deposit again.');
          }
          if ((chosenMethod.type || '').toLowerCase() === 'manual') {
            return this.bot.sendMessage(chatId, 'The "Manual" method is not supported yet. Please run /deposit and choose another method.');
          }

          session.deposit.gateway = chosenMethod;
          session.deposit.step = 'phone';
          this.sessions.set(chatId, session);

          await this.bot.sendMessage(chatId, `Enter the phone number to be charged (international format, e.g., +2376XXXXXXXX):`);

          this.bot.once('message', async (pMsg) => {
            const phone = (pMsg.text || '').trim();
            if (!/^\+?\d{8,15}$/.test(phone)) {
              return this.bot.sendMessage(chatId, 'Invalid phone number. Please run /deposit again.');
            }
            session.deposit.phone = phone;
            session.deposit.step = 'confirm';
            this.sessions.set(chatId, session);

            const recap = [
              'Please confirm your deposit:',
              `• Amount: ${session.deposit.amount} ${session.deposit.wallet.code}`,
              `• Wallet: ${session.deposit.wallet.code} - ${session.deposit.wallet.curr_name}`,
              `• Method: ${session.deposit.gateway.name} (${session.deposit.gateway.type})`,
              `• Phone: ${session.deposit.phone}`,
            ].join('\n');

            const confirmKb = {
              reply_markup: {
                keyboard: [[{ text: '✅ Confirm' }], [{ text: '❌ Cancel' }]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            };
            await this.bot.sendMessage(chatId, recap + '\n\nConfirm to continue.', confirmKb);

            this.bot.once('message', async (cMsg) => {
              const t = (cMsg.text || '').toLowerCase();
              if (!t.includes('confirm')) {
                await this.bot.sendMessage(chatId, 'Deposit cancelled.');
                return;
              }

              const maxAttempts = 3;
              const askPin = (attempt = 1) => {
                const remaining = maxAttempts - attempt + 1;
                const prompt = attempt === 1
                  ? 'Enter your 6-digit PIN:'
                  : `Invalid or rejected PIN. You have ${remaining} attempt(s) left. Enter your 6-digit PIN:`;
                this.bot.sendMessage(chatId, prompt).then(() => {
                  this.bot.once('message', async (pinMsg) => {
                    const pin = (pinMsg.text || '').trim();
                    if (!/^\d{6}$/.test(pin)) {
                      if (attempt < maxAttempts) return askPin(attempt + 1);
                      await this.bot.sendMessage(chatId, 'Too many failed attempts. Deposit cancelled. Type /menu to see services.');
                      return;
                    }

                    // Verify PIN with API using stored user token
                    const email = this.sessions.get(chatId)?.auth?.email;
                    const pinRes = await this.auth.verifyPin(chatId, { email, pin });
                    if (pinRes?.error) {
                      if (attempt < maxAttempts) return askPin(attempt + 1);
                      await this.bot.sendMessage(chatId, 'Too many failed attempts. Deposit cancelled. Type /menu to see services.');
                      return;
                    }

                    // Submit deposit
                    const body = {
                      amount: session.deposit.amount,
                      curr_code: session.deposit.wallet.code,
                      gateway_id: session.deposit.gateway.id,
                      phone_number: session.deposit.phone,
                    };
                    const submitRes = await callLaravelAPI('/user/deposit/submit', chatId, 'POST', body, { session });
                    if (submitRes?.error) {
                      await this.bot.sendMessage(chatId, `❌ Deposit failed: ${submitRes.error}`);
                      return;
                    }

                    // Handle webview_url or success
                    const webview = submitRes.webview_url || submitRes?.response?.webview_url;
                    if (webview) {
                      await this.bot.sendMessage(chatId, `Open this link to finalize your payment: ${webview}`);
                    } else if (submitRes.success || submitRes?.response?.success) {
                      await this.bot.sendMessage(chatId, '✅ Deposit submitted successfully.');
                    } else {
                      await this.bot.sendMessage(chatId, 'Your deposit request has been received.');
                    }
                  });
                });
              };

              // Kick off first PIN prompt
              askPin(1);
            });
          });
        });
      });
    });
  }
}
