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
      await this.bot.sendMessage(chatId, '🔒 <b>Authentication required</b>\n\n⚠️ Please login first with /login', { parse_mode: 'HTML' });
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

    const intro = [
      '💰 <b>Deposit Funds</b>',
      '',
      last3 ? `📈 <u>Your recent deposits:</u>\n${last3}` : '🆕 <i>No recent deposits</i>',
      '',
      '💵 <b>Step 1/4: Amount</b>',
      '',
      'Enter the <u>amount to deposit</u>:',
      '',
      '💡 <i>Example: 10000</i>',
    ].filter(Boolean).join('\n');

    await this.bot.sendMessage(chatId, intro, { parse_mode: 'HTML' });

    // Ask for amount
    this.bot.once('message', async (aMsg) => {
      const amount = parseFloat((aMsg.text || '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) {
        try { await this.botLog?.storeSystem(chatId, 'amount_invalid', { input: aMsg.text }); } catch {}
        return this.bot.sendMessage(chatId, '❌ <b>Invalid amount</b>\n\n⚠️ Please enter a valid number.\n\n🔄 Run /deposit to try again.', { parse_mode: 'HTML' });
      }
      session.deposit.amount = amount;
      session.deposit.step = 'wallet';
      this.sessions.set(chatId, session);

      // Ask wallet selection (show all, but only XAF available for now)
      if (!wallets.length) {
        try { await this.botLog?.storeSystem(chatId, 'no_wallets_available'); } catch {}
        return this.bot.sendMessage(chatId, '⚠️ <b>No wallet available</b>\n\n💼 You don\'t have any wallet on your account.', { parse_mode: 'HTML' });
      }
      const list = wallets.map((w, i) => `   ${i + 1}. <b>${w.code}</b> - ${w.curr_name}`).join('\n');
      await this.bot.sendMessage(chatId, `💼 <b>Step 2/4: Wallet selection</b>\n\n📄 <u>Your wallets:</u>\n${list}\n\n👉 Reply with the number (e.g., 1)`, { parse_mode: 'HTML' });

      this.bot.once('message', async (wMsg) => {
        const idx = parseInt((wMsg.text || '').trim(), 10) - 1;
        const chosen = wallets[idx];
        if (!chosen) {
          try { await this.botLog?.storeSystem(chatId, 'wallet_choice_invalid', { input: wMsg.text }); } catch {}
          return this.bot.sendMessage(chatId, '❌ <b>Invalid choice</b>\n\n⚠️ Please select a valid number.\n\n🔄 Run /deposit to try again.', { parse_mode: 'HTML' });
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
          return this.bot.sendMessage(chatId, '⚠️ <b>No payment methods</b>\n\n💳 No payment methods available for this wallet.', { parse_mode: 'HTML' });
        }

        session.deposit.methods = methods;
        this.sessions.set(chatId, session);

        const listMethods = methods.map((m, i) => `   ${i + 1}. <b>${m.name}</b> <i>(${m.type})</i>`).join('\n');
        await this.bot.sendMessage(chatId, `💳 <b>Step 3/4: Payment method</b>\n\n📄 <u>Available methods:</u>\n${listMethods}\n\n👉 Reply with the number (e.g., 1)`, { parse_mode: 'HTML' });

        this.bot.once('message', async (mReply) => {
          const mIdx = parseInt((mReply.text || '').trim(), 10) - 1;
          const chosenMethod = methods[mIdx];
          if (!chosenMethod) {
            try { await this.botLog?.storeSystem(chatId, 'gateway_choice_invalid', { input: mReply.text }); } catch {}
            return this.bot.sendMessage(chatId, '❌ <b>Invalid choice</b>\n\n⚠️ Please select a valid number.\n\n🔄 Run /deposit to try again.', { parse_mode: 'HTML' });
          }

          session.deposit.gateway = chosenMethod;
          this.sessions.set(chatId, session);

          if ((chosenMethod.type || '').toLowerCase() === 'manual') {
            // Manual flow: ask for receipt upload (image/pdf), no phone number
            const uploadMsg = [
              '📎 <b>Manual Deposit - Payment Receipt</b>',
              '',
              '📤 Please <u>upload your payment receipt</u>:',
              '',
              '📋 <b>Accepted formats:</b>',
              '   • Image (JPG, PNG)',
              '   • PDF Document',
              '',
              '⚠️ <b>Max size:</b> 2 MB'
            ].join('\n');
            await this.bot.sendMessage(chatId, uploadMsg, { parse_mode: 'HTML' });

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
                await this.bot.sendMessage(chatId, '❌ <b>No file detected</b>\n\n⚠️ Please upload a receipt (image or PDF).\n\n🔄 Run /deposit to try again.', { parse_mode: 'HTML' });
                return;
              }

              // Enforce 2MB limit to align with API validation
              if (fileSize && fileSize > 2 * 1024 * 1024) {
                try { await this.botLog?.storeSystem(chatId, 'manual_file_too_large', { size: fileSize }); } catch {}
                await this.bot.sendMessage(chatId, '❌ <b>File too large</b>\n\n⚠️ Maximum allowed size: <b>2 MB</b>\n\nYour file: ${Math.round(fileSize / 1024 / 1024)} MB\n\n🔄 Run /deposit to try again.', { parse_mode: 'HTML' });
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
                  '📋 <b>Manual Deposit Summary</b>',
                  '',
                  '━━━━━━━━━━━━━━━━━━━━',
                  '',
                  `💰 <b>Amount:</b>`,
                  `   <u>${session.deposit.amount} ${session.deposit.wallet.code}</u>`,
                  '',
                  `💼 <b>Wallet:</b>`,
                  `   ${session.deposit.wallet.code} - ${session.deposit.wallet.curr_name}`,
                  '',
                  `💳 <b>Method:</b>`,
                  `   ${session.deposit.gateway.name}`,
                  `   <i>(${session.deposit.gateway.type})</i>`,
                  '',
                  `📎 <b>Receipt file:</b>`,
                  `   ${filename}`,
                  `   <i>(${Math.round((fileSize || buffer.length) / 1024)} KB)</i>`,
                  '',
                  '━━━━━━━━━━━━━━━━━━━━',
                  '',
                  '⚡ <b>Do you confirm this deposit?</b>'
                ].join('\n');

                const confirmKb = {
                  reply_markup: {
                    keyboard: [[{ text: '✅ Confirm' }], [{ text: '❌ Cancel' }]],
                    resize_keyboard: true,
                    one_time_keyboard: true,
                  },
                };
                await this.bot.sendMessage(chatId, recap, { ...confirmKb, parse_mode: 'HTML' });

                this.bot.once('message', async (cMsg) => {
                  const t = (cMsg.text || '').toLowerCase();
                  if (!t.includes('confirm')) {
                    try { await this.botLog?.storeSystem(chatId, 'manual_cancelled_by_user'); } catch {}
                    await this.bot.sendMessage(chatId, '🚫 <b>Deposit cancelled</b>\n\n😊 No problem!\n\n🔜 Return to menu: /menu', { parse_mode: 'HTML' });
                    return;
                  }

                  const maxAttempts = 3;
                  const askPin = (attempt = 1) => {
                    const remaining = maxAttempts - attempt + 1;
                    let prompt;
                    if (attempt === 1) {
                      prompt = [
                        '🔒 <b>Step 4/4: PIN Confirmation</b>',
                        '',
                        '🔐 Enter your <u>PIN code</u> to confirm:',
                        '',
                        '💡 <i>PIN must contain exactly 6 digits</i>'
                      ].join('\n');
                    } else {
                      prompt = [
                        '❌ <b>Incorrect PIN</b>',
                        '',
                        `⚠️ The PIN you entered is invalid or rejected.`,
                        '',
                        `🔄 <b>Attempts remaining: ${remaining}</b>`,
                        '',
                        '🔐 Please enter your <u>PIN code (6 digits)</u> again:'
                      ].join('\n');
                    }
                    this.bot.sendMessage(chatId, prompt, { parse_mode: 'HTML' }).then(() => {
                      this.bot.once('message', async (pinMsg) => {
                        const pin = (pinMsg.text || '').trim();
                        if (!/^\d{6}$/.test(pin)) {
                          try { await this.botLog?.storeSystem(chatId, 'pin_format_invalid'); } catch {}
                          if (attempt < maxAttempts) return askPin(attempt + 1);
                          const failMsg = [
                            '❌ <b>Tentatives épuisées</b>',
                            '',
                            '🚫 Vous avez atteint le nombre maximum de tentatives.',
                            '',
                            '⛔ <b>Dépôt annulé</b>',
                            '',
                            '🔜 Tapez /menu pour voir les services disponibles.'
                          ].join('\n');
                          await this.bot.sendMessage(chatId, failMsg, { parse_mode: 'HTML' });
                          return;
                        }

                        // Verify PIN
                        const email = this.sessions.get(chatId)?.auth?.email;
                        const pinRes = await this.auth.verifyPin(chatId, { email, pin });
                        if (pinRes?.error) {
                          try { await this.botLog?.storeSystem(chatId, 'pin_verify_failed', { error: pinRes.error }); } catch {}
                          if (attempt < maxAttempts) return askPin(attempt + 1);
                          const failMsg = [
                            '❌ <b>Tentatives épuisées</b>',
                            '',
                            '🚫 Vous avez atteint le nombre maximum de tentatives.',
                            '',
                            '⛔ <b>Dépôt annulé</b>',
                            '',
                            '🔜 Tapez /menu pour voir les services disponibles.'
                          ].join('\n');
                          await this.bot.sendMessage(chatId, failMsg, { parse_mode: 'HTML' });
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
                          await this.bot.sendMessage(chatId, `❌ <b>Échec du dépôt</b>\n\n<i>${res.error}</i>\n\n🔄 Veuillez réessayer plus tard.`, { parse_mode: 'HTML' });
                          return;
                        }

                        const webview = res.webview_url || res?.response?.webview_url;
                        if (webview) {
                          const webviewMsg = [
                            '🌐 <b>Finalisation du paiement</b>',
                            '',
                            '👇 Cliquez sur le lien ci-dessous pour finaliser:',
                            '',
                            `${webview}`,
                            '',
                            '⚡ <i>Suivez les instructions pour compléter votre dépôt</i>'
                          ].join('\n');
                          await this.bot.sendMessage(chatId, webviewMsg, { parse_mode: 'HTML' });
                        } else if (res.success || res?.response?.success) {
                          const successMsg = [
                            '🎉 <b>Dépôt soumis avec succès!</b>',
                            '',
                            '✅ Votre dépôt manuel a été traité.',
                            '',
                            `💰 <b>Montant:</b> ${session.deposit.amount} ${session.deposit.wallet.code}`,
                            `📎 <b>Reçu:</b> ${filename}`,
                            '',
                            '⏳ <i>Votre dépôt sera vérifié et validé sous peu.</i>',
                            '',
                            '📱 Tapez /menu pour d\'autres services.'
                          ].join('\n');
                          await this.bot.sendMessage(chatId, successMsg, { parse_mode: 'HTML' });
                        } else {
                          await this.bot.sendMessage(chatId, '📨 <b>Demande reçue</b>\n\n✅ Votre dépôt manuel a été enregistré.\n\n⏳ <i>Il sera vérifié et traité dans les plus brefs délais.</i>', { parse_mode: 'HTML' });
                        }
                      });
                    });
                  };

                  askPin(1);
                });
              } catch (e) {
                try { await this.botLog?.storeSystem(chatId, 'telegram_file_download_failed', { error: e?.message }); } catch {}
                await this.bot.sendMessage(chatId, '❌ <b>Erreur de téléchargement</b>\n\n⚠️ Impossible de télécharger le fichier depuis Telegram.\n\n🔄 Veuillez réessayer avec /deposit.', { parse_mode: 'HTML' });
              }
            });
            return; // stop further automatic flow
          }

          // Non-manual flow (mobile-money / automatic)
          session.deposit.step = 'phone';
          this.sessions.set(chatId, session);

          const phoneMsg = [
            '📱 <b>Étape 4/5: Numéro de téléphone</b>',
            '',
            '🔢 Entrez votre <u>numéro de téléphone</u> à débiter:',
            '',
            '💡 <b>Format:</b> Sans le code pays',
            '   <i>Exemple: 677831959</i>',
            '',
            '⚠️ <i>Assurez-vous que ce numéro peut recevoir des notifications de paiement</i>'
          ].join('\n');
          
          await this.bot.sendMessage(chatId, phoneMsg, { parse_mode: 'HTML' });

          this.bot.once('message', async (pMsg) => {
            const phone = (pMsg.text || '').trim();
            if (!/^\+?\d{8,15}$/.test(phone)) {
              try { await this.botLog?.storeSystem(chatId, 'phone_invalid', { input: pMsg.text }); } catch {}
              return this.bot.sendMessage(chatId, '❌ <b>Numéro invalide</b>\n\n⚠️ Le format du numéro n\'est pas correct.\n\n💡 <i>Entrez uniquement les chiffres sans espaces (ex: 677831959)</i>\n\n🔄 Relancez /deposit pour recommencer.', { parse_mode: 'HTML' });
            }
            session.deposit.phone = phone;
            session.deposit.step = 'confirm';
            this.sessions.set(chatId, session);

            const recap = [
              '📋 <b>Récapitulatif du Dépôt</b>',
              '',
              '━━━━━━━━━━━━━━━━━━━━',
              '',
              `💰 <b>Montant:</b>`,
              `   <u>${session.deposit.amount} ${session.deposit.wallet.code}</u>`,
              '',
              `💼 <b>Wallet:</b>`,
              `   ${session.deposit.wallet.code} - ${session.deposit.wallet.curr_name}`,
              '',
              `💳 <b>Méthode:</b>`,
              `   ${session.deposit.gateway.name}`,
              `   <i>(${session.deposit.gateway.type})</i>`,
              '',
              `📱 <b>Téléphone:</b>`,
              `   ${session.deposit.phone}`,
              '',
              '━━━━━━━━━━━━━━━━━━━━',
              '',
              '⚡ <b>Confirmez-vous ce dépôt?</b>'
            ].join('\n');

            const confirmKb = {
              reply_markup: {
                keyboard: [[{ text: '✅ Confirm' }], [{ text: '❌ Cancel' }]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            };
            await this.bot.sendMessage(chatId, recap, { ...confirmKb, parse_mode: 'HTML' });

            this.bot.once('message', async (cMsg) => {
              const t = (cMsg.text || '').toLowerCase();
              if (!t.includes('confirm')) {
                try { await this.botLog?.storeSystem(chatId, 'deposit_cancelled_by_user'); } catch {}
                await this.bot.sendMessage(chatId, '🚫 <b>Dépôt annulé</b>\n\n😊 Aucun problème!\n\n🔜 Revenez au menu: /menu', { parse_mode: 'HTML' });
                return;
              }

              const maxAttempts = 3;
              const askPin = (attempt = 1) => {
                const remaining = maxAttempts - attempt + 1;
                let prompt;
                if (attempt === 1) {
                  prompt = [
                    '🔒 <b>Étape 5/5: Confirmation avec PIN</b>',
                    '',
                    '🔐 Entrez votre <u>code PIN</u> pour confirmer:',
                    '',
                    '💡 <i>Le PIN doit contenir exactement 6 chiffres</i>'
                  ].join('\n');
                } else {
                  prompt = [
                    '❌ <b>PIN Incorrect</b>',
                    '',
                    `⚠️ Le PIN que vous avez entré est invalide ou rejeté.`,
                    '',
                    `🔄 <b>Tentatives restantes: ${remaining}</b>`,
                    '',
                    '🔐 Veuillez entrer de nouveau votre <u>code PIN (6 chiffres)</u>:'
                  ].join('\n');
                }
                this.bot.sendMessage(chatId, prompt, { parse_mode: 'HTML' }).then(() => {
                  this.bot.once('message', async (pinMsg) => {
                    const pin = (pinMsg.text || '').trim();
                    if (!/^\d{6}$/.test(pin)) {
                      try { await this.botLog?.storeSystem(chatId, 'pin_format_invalid'); } catch {}
                      if (attempt < maxAttempts) return askPin(attempt + 1);
                      const failMsg = [
                        '❌ <b>Tentatives épuisées</b>',
                        '',
                        '🚫 Vous avez atteint le nombre maximum de tentatives.',
                        '',
                        '⛔ <b>Dépôt annulé</b>',
                        '',
                        '🔜 Tapez /menu pour voir les services disponibles.'
                      ].join('\n');
                      await this.bot.sendMessage(chatId, failMsg, { parse_mode: 'HTML' });
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
                      const failMsg = [
                        '❌ <b>Tentatives épuisées</b>',
                        '',
                        '🚫 Vous avez atteint le nombre maximum de tentatives.',
                        '',
                        '⛔ <b>Dépôt annulé</b>',
                        '',
                        '🔜 Tapez /menu pour voir les services disponibles.'
                      ].join('\n');
                      await this.bot.sendMessage(chatId, failMsg, { parse_mode: 'HTML' });
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
                      await this.bot.sendMessage(chatId, `❌ <b>Échec du dépôt</b>\n\n<i>${submitRes.error}</i>\n\n🔄 Veuillez réessayer plus tard.`, { parse_mode: 'HTML' });
                      return;
                    }

                    // Handle webview_url or success
                    const webview = submitRes.webview_url || submitRes?.response?.webview_url;
                    if (webview) {
                      const webviewMsg = [
                        '🌐 <b>Finalisation du paiement</b>',
                        '',
                        '👇 Cliquez sur le lien ci-dessous pour finaliser votre paiement:',
                        '',
                        `${webview}`,
                        '',
                        '⚡ <i>Vous serez redirigé vers votre opérateur mobile</i>'
                      ].join('\n');
                      await this.bot.sendMessage(chatId, webviewMsg, { parse_mode: 'HTML' });
                    } else if (submitRes.success || submitRes?.response?.success) {
                      const successMsg = [
                        '🎉 <b>Dépôt soumis avec succès!</b>',
                        '',
                        '✅ Votre dépôt a été traité.',
                        '',
                        `💰 <b>Montant:</b> ${session.deposit.amount} ${session.deposit.wallet.code}`,
                        `📱 <b>Téléphone:</b> ${session.deposit.phone}`,
                        '',
                        '📱 Tapez /menu pour d\'autres services.'
                      ].join('\n');
                      await this.bot.sendMessage(chatId, successMsg, { parse_mode: 'HTML' });
                    } else {
                      await this.bot.sendMessage(chatId, '📨 <b>Demande reçue</b>\n\n✅ Votre demande de dépôt a été enregistrée.\n\n⏳ <i>Elle sera traitée dans les plus brefs délais.</i>', { parse_mode: 'HTML' });
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
