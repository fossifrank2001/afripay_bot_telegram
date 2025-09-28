import { callLaravelAPI, uploadMultipart } from '../services/api.js';
import axios from 'axios';
import FormData from 'form-data';
import { UtilService } from '../utils/loader.js';

export class DepositHandler {
  constructor(bot, sessions, authService, botLog) {
    this.bot = bot;
    this.sessions = sessions;
    this.auth = authService;
    this.botLog = botLog;
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
    const data = await UtilService.withLoader(this.bot, chatId, 'Fetching deposit data…', async () => {
      return await callLaravelAPI('/user/deposit', chatId, 'GET', {}, { session });
    });

    if (data?.error) {
      try { await this.botLog?.storeSystem(chatId, 'wallets_fetch_failed', { error: data.error }); } catch {}
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
      const date = UtilService.formatDT(h.created_at);
      return `▫️ ${amount} | method: ${method} | ${status} | ${date}`;
    }).join('\n');

    const histBlock = last3 ? `💰 Last deposits:\n${last3}\n\n` : '';

    await this.bot.sendMessage(chatId, histBlock + 'Enter the amount to deposit (e.g., 10000). This amount will top up your balance in the selected wallet.');

    // Ask for amount
    this.bot.once('message', async (aMsg) => {
      const amount = parseFloat((aMsg.text || '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) {
        try { await this.botLog?.storeSystem(chatId, 'amount_invalid', { input: aMsg.text }); } catch {}
        return this.bot.sendMessage(chatId, 'Invalid amount. Please run /deposit again.');
      }
      session.deposit.amount = amount;
      session.deposit.step = 'wallet';
      this.sessions.set(chatId, session);

      // Ask wallet selection (show all, but only XAF available for now)
      if (!wallets.length) {
        try { await this.botLog?.storeSystem(chatId, 'no_wallets_available'); } catch {}
        return this.bot.sendMessage(chatId, 'No wallets available on your account.');
      }
      const list = wallets.map((w, i) => `${i + 1}) ${w.code} - ${w.curr_name}`).join('\n');
      await this.bot.sendMessage(chatId, `Choose the wallet:\n${list}\n\nReply with the number (e.g., 1).`);

      this.bot.once('message', async (wMsg) => {
        const idx = parseInt((wMsg.text || '').trim(), 10) - 1;
        const chosen = wallets[idx];
        if (!chosen) {
          try { await this.botLog?.storeSystem(chatId, 'wallet_choice_invalid', { input: wMsg.text }); } catch {}
          return this.bot.sendMessage(chatId, 'Invalid choice. Please run /deposit again.');
        }
        if ((chosen.code || '').toUpperCase() !== 'XAF') {
          try { await this.botLog?.storeSystem(chatId, 'wallet_not_supported', { code: chosen.code }); } catch {}
          await this.bot.sendMessage(chatId, `Wallet ${chosen.code} is not available for now. Only XAF is supported. Please run /deposit again.`);
          return;
        }
        session.deposit.wallet = chosen;
        session.deposit.step = 'gateway';
        this.sessions.set(chatId, session);

        // Fetch gateway methods for selected wallet
        const methodsRes = await UtilService.withLoader(this.bot, chatId, 'Fetching payment methods…', async () => {
          return await callLaravelAPI('/user/gateway-methods', chatId, 'GET', { currency_id: String(chosen.id) }, { session });
        });

        if (methodsRes?.error) {
          try { await this.botLog?.storeSystem(chatId, 'gateway_methods_failed', { error: methodsRes.error }); } catch {}
          return this.bot.sendMessage(chatId, `❌ Payment methods error: ${methodsRes.error}`);
        }
        const methods = methodsRes?.response?.methods || methodsRes?.methods || [];
        if (!methods.length) {
          try { await this.botLog?.storeSystem(chatId, 'no_gateway_methods'); } catch {}
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
            try { await this.botLog?.storeSystem(chatId, 'gateway_choice_invalid', { input: mReply.text }); } catch {}
            return this.bot.sendMessage(chatId, 'Invalid choice. Please run /deposit again.');
          }

          session.deposit.gateway = chosenMethod;
          this.sessions.set(chatId, session);

          if ((chosenMethod.type || '').toLowerCase() === 'manual') {
            // Manual flow: ask for receipt upload (image/pdf), no phone number
            await this.bot.sendMessage(chatId, 'Please upload the payment receipt (image JPG/PNG or PDF). Max size: 2 MB.');

            this.bot.once('message', async (fileMsg) => {
              const doc = fileMsg.document;
              const photos = fileMsg.photo;
              let fileId, fileSize, mime, filename;

              if (doc) {
                fileId = doc.file_id;
                fileSize = doc.file_size;
                mime = doc.mime_type || 'application/octet-stream';
                filename = doc.file_name || 'receipt';
              } else if (Array.isArray(photos) && photos.length) {
                const best = photos[photos.length - 1];
                fileId = best.file_id;
                fileSize = best.file_size;
                mime = 'image/jpeg';
                filename = 'receipt.jpg';
              } else {
                try { await this.botLog?.storeSystem(chatId, 'manual_no_file_detected'); } catch {}
                await this.bot.sendMessage(chatId, 'No file detected. Please run /deposit again and upload a receipt.');
                return;
              }

              // Enforce 2MB limit to align with API validation
              if (fileSize && fileSize > 2 * 1024 * 1024) {
                try { await this.botLog?.storeSystem(chatId, 'manual_file_too_large', { size: fileSize }); } catch {}
                await this.bot.sendMessage(chatId, 'File too large. Max allowed size is 2 MB. Please run /deposit again.');
                return;
              }

              try {
                const fileUrl = await this.bot.getFileLink(fileId);
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);

                // Log the incoming file as a message and attach it for auditing
                try {
                  const sentAt = fileMsg.date ? new Date(fileMsg.date * 1000).toISOString() : undefined;
                  const fileLog = await this.botLog?.storeMessage(chatId, {
                    direction: 'incoming',
                    message_type: 'file',
                    content: filename,
                    payload: { mime, size: fileSize },
                    external_message_id: String(fileMsg.message_id),
                    sent_at: sentAt,
                  });
                  const messageId = fileLog?.message_id;
                  if (messageId) {
                    await this.botLog?.uploadAttachment(chatId, messageId, buffer, filename, mime);
                  }
                } catch (logErr) {
                  try { await this.botLog?.storeSystem(chatId, 'file_log_failed', { error: logErr?.message }); } catch {}
                }

                // Recap before asking confirmation + PIN
                const recap = [
                  'Please confirm your manual deposit:',
                  `• Amount: ${session.deposit.amount} ${session.deposit.wallet.code}`,
                  `• Wallet: ${session.deposit.wallet.code} - ${session.deposit.wallet.curr_name}`,
                  `• Method: ${session.deposit.gateway.name} (${session.deposit.gateway.type})`,
                  `• Receipt file: ${filename} (${Math.round((fileSize || buffer.length) / 1024)} KB)`,
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
                    try { await this.botLog?.storeSystem(chatId, 'manual_cancelled_by_user'); } catch {}
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
                          try { await this.botLog?.storeSystem(chatId, 'pin_format_invalid'); } catch {}
                          if (attempt < maxAttempts) return askPin(attempt + 1);
                          await this.bot.sendMessage(chatId, 'Too many failed attempts. Deposit cancelled. Type /menu to see services.');
                          return;
                        }

                        // Verify PIN
                        const email = this.sessions.get(chatId)?.auth?.email;
                        const pinRes = await this.auth.verifyPin(chatId, { email, pin });
                        if (pinRes?.error) {
                          try { await this.botLog?.storeSystem(chatId, 'pin_verify_failed', { error: pinRes.error }); } catch {}
                          if (attempt < maxAttempts) return askPin(attempt + 1);
                          await this.bot.sendMessage(chatId, 'Too many failed attempts. Deposit cancelled. Type /menu to see services.');
                          return;
                        }

                        // Build multipart form and upload
                        const form = new FormData();
                        form.append('receipt', buffer, { filename, contentType: mime });
                        form.append('amount', String(session.deposit.amount));
                        form.append('curr_code', session.deposit.wallet.code);
                        form.append('gateway_id', String(session.deposit.gateway.id));
                        // Provide keyword for manual flow if backend expects it
                        form.append('gateway', session.deposit.gateway.keyword || 'manual-deposit');

                        const res = await UtilService.withLoader(this.bot, chatId, 'Submitting deposit…', async () => {
                          return await uploadMultipart('/user/deposit/submit', chatId, form, { session });
                        });
                        if (res?.error) {
                          try { await this.botLog?.storeSystem(chatId, 'manual_submit_failed', { error: res.error }); } catch {}
                          await this.bot.sendMessage(chatId, `❌ Deposit failed: ${res.error}`);
                          return;
                        }

                        const webview = res.webview_url || res?.response?.webview_url;
                        if (webview) {
                          await this.bot.sendMessage(chatId, `Open this link to finalize your payment: ${webview}`);
                        } else if (res.success || res?.response?.success) {
                          await this.bot.sendMessage(chatId, '✅ Deposit submitted successfully.');
                        } else {
                          await this.bot.sendMessage(chatId, 'Your deposit request has been received.');
                        }
                      });
                    });
                  };

                  askPin(1);
                });
              } catch (e) {
                try { await this.botLog?.storeSystem(chatId, 'telegram_file_download_failed', { error: e?.message }); } catch {}
                await this.bot.sendMessage(chatId, 'Could not download the file from Telegram. Please try again.');
              }
            });
            return; // stop further automatic flow
          }

          // Non-manual flow (mobile-money / automatic)
          session.deposit.step = 'phone';
          this.sessions.set(chatId, session);

          await this.bot.sendMessage(chatId, `Enter the phone number to be charged (international format, e.g., +2376XXXXXXXX):`);

          this.bot.once('message', async (pMsg) => {
            const phone = (pMsg.text || '').trim();
            if (!/^\+?\d{8,15}$/.test(phone)) {
              try { await this.botLog?.storeSystem(chatId, 'phone_invalid', { input: pMsg.text }); } catch {}
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
                try { await this.botLog?.storeSystem(chatId, 'deposit_cancelled_by_user'); } catch {}
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
                      try { await this.botLog?.storeSystem(chatId, 'pin_format_invalid'); } catch {}
                      if (attempt < maxAttempts) return askPin(attempt + 1);
                      await this.bot.sendMessage(chatId, 'Too many failed attempts. Deposit cancelled. Type /menu to see services.');
                      return;
                    }

                    // Verify PIN with API using stored user token
                    const email = this.sessions.get(chatId)?.auth?.email;
                    const pinRes = await UtilService.withLoader(this.bot, chatId, 'Verifying PIN…', async () => {
                      return await this.auth.verifyPin(chatId, { email, pin });
                    });
                    if (pinRes?.error) {
                      try { await this.botLog?.storeSystem(chatId, 'pin_verify_failed', { error: pinRes.error }); } catch {}
                      if (attempt < maxAttempts) return askPin(attempt + 1);
                      await this.bot.sendMessage(chatId, 'Too many failed attempts. Deposit cancelled. Type /menu to see services.');
                      return;
                    }

                    // Submit deposit (JSON)
                    const body = {
                      amount: session.deposit.amount,
                      curr_code: session.deposit.wallet.code,
                      gateway_id: session.deposit.gateway.id,
                      phone_number: session.deposit.phone,
                    };
                    
                    const submitRes = await UtilService.withLoader(this.bot, chatId, 'Submitting deposit…', async () => {
                      return await callLaravelAPI('/user/deposit/submit', chatId, 'POST', body, { session });
                    });

                    if (submitRes?.error) {
                      try { await this.botLog?.storeSystem(chatId, 'deposit_submit_failed', { error: submitRes.error }); } catch {}
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
