import axios from 'axios';
import FormData from 'form-data';
import { UtilService } from '../utils/loader.js';
import { TransferService } from '../services/TransferService.js';

export class TransferHandler {
  constructor(bot, sessions, authService, botLog) {
    this.bot = bot;
    this.sessions = sessions;
    this.auth = authService;
    this.botLog = botLog;
    this.transfer = new TransferService(this.sessions);
  }

  register() {
    this.bot.onText(/\/transfer/, (msg) => this.start(msg));
  }

  async start(msg) {
    const chatId = msg.chat.id;
    const session = this.sessions.get(chatId);
    if (!session?.auth?.isAuthed) {
      await this.bot.sendMessage(chatId, '🔒 <b>Authentication required</b>\n\n⚠️ Please login first with /login', { parse_mode: 'HTML' });
      return;
    }

    const transferOptionsMsg = [
      '💸 <b>Transfer Options</b>',
      '',
      '📋 <u>Choose your transfer type:</u>',
      '',
      '1️⃣ <b>To Beneficiary</b>',
      '   • Transfer money to a saved beneficiary',
      '   • <i>🚧 Coming soon!</i>',
      '',
      '2️⃣ <b>Bank Transfer</b>',
      '   • Transfer money to any bank account',
      '   • <i>✅ Available now</i>',
      '',
      '👇 Reply with <b>1</b> or <b>2</b> to choose:'
    ].join('\n');

    await this.bot.sendMessage(chatId, transferOptionsMsg, { parse_mode: 'HTML' });

    this.bot.once('message', async (choiceMsg) => {
      const choice = (choiceMsg.text || '').trim();

      if (choice === '1') {
        const comingSoonMsg = [
          '🚧 <b>Feature Coming Soon</b>',
          '',
          '⏳ The "To Beneficiary" transfer feature is under development.',
          '',
          '✨ <b>Soon you will be able to:</b>',
          '   • Save beneficiary information',
          '   • Quick transfers to saved beneficiaries',
          '   • Manage your beneficiary list',
          '',
          '🔜 Stay tuned for updates!',
          '',
          '📱 Return to menu: /menu'
        ].join('\n');
        await this.bot.sendMessage(chatId, comingSoonMsg, { parse_mode: 'HTML' });
        return;
      } else if (choice === '2') {
        await this.startBankTransfer(msg);
      } else {
        await this.bot.sendMessage(chatId, '❌ <b>Invalid choice</b>\n\n⚠️ Please reply with 1 or 2.\n\n🔄 Run /transfer to try again.', { parse_mode: 'HTML' });
      }
    });
  }

  async startBankTransfer(msg) {
    const chatId = msg.chat.id;
    const session = this.sessions.get(chatId);

    const walletsData = await UtilService.withLoader(this.bot, chatId, 'Fetching your wallets…', async () => {
      return await this.transfer.fetchWallets(chatId);
    });

    if (walletsData?.error) {
      try { await this.botLog?.storeSystem(chatId, 'bank_transfer_wallets_fetch_failed', { error: walletsData.error }); } catch {}
      console.error('[transfer] fetchWallets failed:', walletsData);
      return this.bot.sendMessage(chatId, `❌ Error: ${walletsData.error}`);
    }

    const wallets = walletsData?.response || walletsData || [];

    if (!wallets.length) {
      try { await this.botLog?.storeSystem(chatId, 'no_wallets_for_bank_transfer'); } catch {}
      return this.bot.sendMessage(chatId, '⚠️ <b>No wallet available</b>\n\n💼 You don\'t have any wallet with sufficient balance.', { parse_mode: 'HTML' });
    }

    session.bankTransfer = { step: 'wallet', wallets };
    this.sessions.set(chatId, session);

    await this.askWallet(chatId, session, wallets);
  }

  async askWallet(chatId, session, wallets) {
    const walletList = wallets.map((w, i) => {
      const raw = (w?.balance ?? 0);
      const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
      const balance = Number.isFinite(num) ? num : 0;
      return `   ${i + 1}. <b>${w?.currency?.code || 'N/A'}</b> --- ( ${balance.toFixed(2)} )`;
    }).join('\n');

    await this.bot.sendMessage(chatId, `🏦 <b>Bank Transfer - Step 1/9</b>\n\n💼 <u>Select your wallet:</u>\n${walletList}\n\n👉 Reply with the number:`, { parse_mode: 'HTML' });

    this.bot.once('message', (wMsg) => this.handleWalletSelection(chatId, session, wallets, wMsg));
  }

  async handleWalletSelection(chatId, session, wallets, wMsg) {
    const idx = parseInt((wMsg.text || '').trim(), 10) - 1;
    const chosenWallet = wallets[idx];
    if (!chosenWallet) {
      return this.bot.sendMessage(chatId, '❌ Invalid choice. Run /transfer to try again.', { parse_mode: 'HTML' });
    }

    session.bankTransfer.wallet = chosenWallet;
    session.bankTransfer.currencyCode = chosenWallet.currency?.code;
    this.sessions.set(chatId, session);

    await this.askAmount(chatId, session, chosenWallet);
  }

  async askAmount(chatId, session, wallet) {
    const raw = (wallet?.balance ?? 0);
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
    const available = Number.isFinite(num) ? num : 0;
    await this.bot.sendMessage(chatId, `🏦 <b>Bank Transfer - Step 2/9</b>\n\n💰 Enter amount in <b>${wallet?.currency?.code}</b>:\n\n💼 Available: ${available.toFixed(2)}`, { parse_mode: 'HTML' });
    this.bot.once('message', (aMsg) => this.handleAmount(chatId, session, aMsg));
  }

  async handleAmount(chatId, session, aMsg) {
    const amount = parseFloat((aMsg.text || '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      return this.bot.sendMessage(chatId, '❌ Invalid amount. Run /transfer to try again.');
    }

    session.bankTransfer.amount = amount;
    this.sessions.set(chatId, session);

    const banksData = await UtilService.withLoader(this.bot, chatId, 'Fetching banks…', async () => {
      return await this.transfer.fetchBanks(chatId, session.bankTransfer.currencyCode);
    });

    if (banksData?.error) {
      console.error('[transfer] fetchBanks failed:', banksData);
      return this.bot.sendMessage(chatId, `❌ Error: ${banksData.error}`);
    }

    const banks = banksData?.response || banksData || [];
    if (!banks.length) {
      return this.bot.sendMessage(chatId, '⚠️ No banks available for this currency.');
    }

    session.bankTransfer.banks = banks;
    this.sessions.set(chatId, session);

    await this.askBank(chatId, session, banks);
  }

  async askBank(chatId, session, banks) {
    const bankList = banks.map((b, i) => `   ${i + 1}. <b>${b.title}</b>`).join('\n');
    await this.bot.sendMessage(chatId, `🏦 <b>Bank Transfer - Step 3/9</b>\n\n🏦 Select bank:\n${bankList}\n\n👉 Reply with number:`, { parse_mode: 'HTML' });
    this.bot.once('message', (bMsg) => this.handleBankSelection(chatId, session, banks, bMsg));
  }

  async handleBankSelection(chatId, session, banks, bMsg) {
    const idx = parseInt((bMsg.text || '').trim(), 10) - 1;
    const chosenBank = banks[idx];
    if (!chosenBank) {
      return this.bot.sendMessage(chatId, '❌ Invalid choice. Run /transfer again.');
    }

    session.bankTransfer.bank = chosenBank.title;
    this.sessions.set(chatId, session);
    await this.askIBAN(chatId, session);
  }

  async askIBAN(chatId, session) {
    await this.bot.sendMessage(chatId, '🏦 <b>Bank Transfer - Step 4/9</b>\n\n🔢 Enter IBAN/Account Number:', { parse_mode: 'HTML' });
    this.bot.once('message', (iMsg) => this.handleIBAN(chatId, session, iMsg));
  }

  async handleIBAN(chatId, session, iMsg) {
    const iban = (iMsg.text || '').trim();
    if (!iban || iban.length < 5) {
      return this.bot.sendMessage(chatId, '❌ Invalid IBAN. Run /transfer again.');
    }

    session.bankTransfer.iban = iban;
    this.sessions.set(chatId, session);
    await this.askAccountName(chatId, session);
  }

  async askAccountName(chatId, session) {
    await this.bot.sendMessage(chatId, '🏦 <b>Bank Transfer - Step 5/9</b>\n\n👤 Enter Account Holder Name:', { parse_mode: 'HTML' });
    this.bot.once('message', (nMsg) => this.handleAccountName(chatId, session, nMsg));
  }

  async handleAccountName(chatId, session, nMsg) {
    const accountName = (nMsg.text || '').trim();
    if (!accountName || accountName.length < 3) {
      return this.bot.sendMessage(chatId, '❌ Invalid name. Run /transfer again.');
    }

    session.bankTransfer.account_name = accountName;
    this.sessions.set(chatId, session);
    await this.askObject(chatId, session);
  }

  async askObject(chatId, session) {
    await this.bot.sendMessage(chatId, '🏦 <b>Bank Transfer - Step 6/9</b>\n\n📝 Enter transfer purpose:\n\n💡 Example: Invoice payment', { parse_mode: 'HTML' });
    this.bot.once('message', (oMsg) => this.handleObject(chatId, session, oMsg));
  }

  async handleObject(chatId, session, oMsg) {
    const object = (oMsg.text || '').trim();
    if (!object || object.length < 3) {
      return this.bot.sendMessage(chatId, '❌ Invalid purpose. Run /transfer again.');
    }

    session.bankTransfer.object = object;
    this.sessions.set(chatId, session);
    await this.askInvoiceScan(chatId, session);
  }

  async askInvoiceScan(chatId, session) {
    const msg = '🏦 <b>Bank Transfer - Step 7/9</b>\n\n📎 Upload Invoice Scan (Required)\n\n📤 Accepted: Image or PDF (Max 2MB)';
    await this.bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    this.bot.once('message', (fMsg) => this.handleInvoiceScan(chatId, session, fMsg));
  }

  async handleInvoiceScan(chatId, session, fMsg) {
    const file = await this.extractFile(fMsg);
    if (!file) {
      return this.bot.sendMessage(chatId, '❌ No file detected. Run /transfer again.');
    }
    if (file.size > 2 * 1024 * 1024) {
      return this.bot.sendMessage(chatId, '❌ File too large (Max 2MB). Run /transfer again.');
    }

    try {
      const buffer = await this.downloadFile(file.id);

      // Log the incoming file in conversation history and attach binary (like manual deposit)
      try {
        const sentAt = fMsg.date ? new Date(fMsg.date * 1000).toISOString() : undefined;
        const fileLog = await this.botLog?.storeMessage(chatId, {
          direction: 'incoming',
          message_type: 'file',
          content: file.name,
          payload: { mime: file.mime, size: file.size },
          external_message_id: String(fMsg.message_id),
          sent_at: sentAt,
        });
        const messageId = fileLog?.message_id;
        if (messageId) {
          await this.botLog?.uploadAttachment(chatId, messageId, buffer, file.name, file.mime);
        }
      } catch (logErr) {
        try { await this.botLog?.storeSystem(chatId, 'invoice_log_failed', { error: logErr?.message }); } catch {}
      }

      // Store buffer to send with final transfer payload
      session.bankTransfer.scan_invoice = { buffer, filename: file.name, mime: file.mime };
      this.sessions.set(chatId, session);

      await this.askBankInfoScan(chatId, session);
    } catch (e) {
      console.error('[transfer] invoice_download_error:', e);
      return this.bot.sendMessage(chatId, '❌ Download error. Run /transfer again.');
    }
  }

  async askBankInfoScan(chatId, session) {
    const msg = '🏦 <b>Bank Transfer - Step 8/9</b>\n\n📎 Upload Bank Info (Optional)\n\n💡 Type <b>SKIP</b> to continue:';
    await this.bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    this.bot.once('message', (fMsg) => this.handleBankInfoScan(chatId, session, fMsg));
  }

  async handleBankInfoScan(chatId, session, fMsg) {
    if ((fMsg.text || '').trim().toLowerCase() === 'skip') {
      session.bankTransfer.scan_bank_infos = null;
      this.sessions.set(chatId, session);
      await this.askAddress(chatId, session);
      return;
    }

    const file = await this.extractFile(fMsg);
    if (!file) {
      session.bankTransfer.scan_bank_infos = null;
      this.sessions.set(chatId, session);
      await this.askAddress(chatId, session);
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      console.warn('[transfer] bank_info_file_too_large:', { size: file.size });
      await this.bot.sendMessage(chatId, '⚠️ File too large. Continuing without it...');
      session.bankTransfer.scan_bank_infos = null;
      this.sessions.set(chatId, session);
      await this.askAddress(chatId, session);
      return;
    }

    try {
      const buffer = await this.downloadFile(file.id);
      session.bankTransfer.scan_bank_infos = { buffer, filename: file.name, mime: file.mime };
      this.sessions.set(chatId, session);
      await this.askAddress(chatId, session);
    } catch (e) {
      console.error('[transfer] bank_info_download_failed:', e);
      session.bankTransfer.scan_bank_infos = null;
      this.sessions.set(chatId, session);
      await this.askAddress(chatId, session);
    }
  }

  async askAddress(chatId, session) {
    await this.bot.sendMessage(chatId, '🏦 <b>Bank Transfer - Step 9/9</b>\n\n🏠 Enter recipient address (Required)\n\n💡 Example: Street 22, New York', { parse_mode: 'HTML' });
    this.bot.once('message', (aMsg) => this.handleAddress(chatId, session, aMsg));
  }

  async handleAddress(chatId, session, aMsg) {
    const text = (aMsg.text || '').trim();
    if (!text || text.length < 3) {
      await this.bot.sendMessage(chatId, '❌ Invalid address. Please provide a valid address (min 3 characters).', { parse_mode: 'HTML' });
      return this.askAddress(chatId, session);
    }

    session.bankTransfer.address = text;
    this.sessions.set(chatId, session);

    const detailsData = await UtilService.withLoader(this.bot, chatId, 'Calculating fees…', async () => {
      return await this.transfer.calculateDetails(chatId, {
        currency: session.bankTransfer.currencyCode,
        amount: session.bankTransfer.amount,
        bank: session.bankTransfer.bank,
      });
    });

    let fees = '0', tva = '0', finalAmount = session.bankTransfer.amount;
    if (detailsData && !detailsData.error) {
      const d = detailsData.response || detailsData;
      fees = d.fees || '0';
      tva = d.tva || '0';
      finalAmount = d.finalAmount || finalAmount;
      session.bankTransfer.details = d;
      this.sessions.set(chatId, session);
    } else if (detailsData?.error) {
      console.error('[transfer] calculateDetails failed:', detailsData);
    }

    await this.showRecapAndConfirm(chatId, session, fees, tva, finalAmount);
  }

  async showRecapAndConfirm(chatId, session, fees, tva, finalAmount) {
    const bt = session.bankTransfer;
    const recap = [
      '📋 <b>Bank Transfer Summary</b>',
      '',
      `💰 Amount: ${bt.amount} ${bt.currencyCode}`,
      `🏦 Bank: ${bt.bank}`,
      `🔢 IBAN: ${bt.iban}`,
      `👤 Holder: ${bt.account_name}`,
      `📝 Purpose: ${bt.object}`,
      `📎 Invoice: ${bt.scan_invoice?.filename}`,
      `📎 Bank Info: ${bt.scan_bank_infos ? bt.scan_bank_infos.filename : 'No'}`,
      `🏠 Address: ${bt.address || 'No'}`,
      '',
      `💳 Fees: ${fees}`,
      `📊 TVA: ${tva}`,
      `💰 Total: ${finalAmount}`,
      '',
      '⚡ Confirm this transfer?'
    ].join('\n');

    const kb = {
      reply_markup: {
        keyboard: [[{ text: '✅ Confirm' }], [{ text: '❌ Cancel' }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };

    await this.bot.sendMessage(chatId, recap, { ...kb, parse_mode: 'HTML' });
    this.bot.once('message', (cMsg) => this.handleConfirmation(chatId, session, cMsg));
  }

  async handleConfirmation(chatId, session, cMsg) {
    const t = (cMsg.text || '').toLowerCase();
    if (!t.includes('confirm')) {
      return this.bot.sendMessage(chatId, '🚫 Transfer cancelled. /menu to return.');
    }

    await this.askPIN(chatId, session, 1);
  }

  async askPIN(chatId, session, attempt) {
    const maxAttempts = 3;
    const remaining = maxAttempts - attempt + 1;
    let prompt = attempt === 1 
      ? '🔒 <b>PIN Confirmation</b>\n\n🔐 Enter your 6-digit PIN:' 
      : `❌ <b>Incorrect PIN</b>\n\n🔄 Attempts remaining: ${remaining}\n\n🔐 Enter PIN again:`;

    await this.bot.sendMessage(chatId, prompt, { parse_mode: 'HTML' });
    this.bot.once('message', (pMsg) => this.handlePIN(chatId, session, pMsg, attempt, maxAttempts));
  }

  async handlePIN(chatId, session, pMsg, attempt, maxAttempts) {
    const pin = (pMsg.text || '').trim();
    if (!/^\d{6}$/.test(pin)) {
      if (attempt < maxAttempts) return this.askPIN(chatId, session, attempt + 1);
      return this.bot.sendMessage(chatId, '❌ Max attempts reached. Transfer cancelled. /menu');
    }

    const email = session.auth?.email;
    const pinRes = await this.auth.verifyPin(chatId, { email, pin });
    if (pinRes?.error) {
      if (attempt < maxAttempts) return this.askPIN(chatId, session, attempt + 1);
      return this.bot.sendMessage(chatId, '❌ Max attempts reached. Transfer cancelled. /menu');
    }

    await this.submitBankTransfer(chatId, session);
  }

  async submitBankTransfer(chatId, session) {
    const bt = session.bankTransfer;
    const form = new FormData();
    
    form.append('wallet', String(bt.wallet.id));
    form.append('amount', String(bt.amount));
    form.append('bank', bt.bank);
    form.append('iban', bt.iban);
    form.append('account_name', bt.account_name);
    form.append('object', bt.object);
    form.append('address', bt.address || '');
    form.append('scan_invoice', bt.scan_invoice.buffer, { filename: bt.scan_invoice.filename, contentType: bt.scan_invoice.mime });
    
    if (bt.scan_bank_infos) {
      form.append('scan_bank_infos', bt.scan_bank_infos.buffer, { filename: bt.scan_bank_infos.filename, contentType: bt.scan_bank_infos.mime });
    }

    const res = await UtilService.withLoader(this.bot, chatId, 'Submitting transfer…', async () => {
      return await this.transfer.submit(chatId, form);
    });

    if (res?.error) {
      console.error('[transfer] submit transfer failed:', res);
      return this.bot.sendMessage(chatId, `❌ <b>Transfer failed</b>\n\n${res.error}\n\n🔄 Try again later.`, { parse_mode: 'HTML' });
    }

    const successMsg = [
      '🎉 <b>Transfer submitted successfully!</b>',
      '',
      `💰 Amount: ${bt.amount} ${bt.currencyCode}`,
      `🏦 Bank: ${bt.bank}`,
      `👤 To: ${bt.account_name}`,
      '',
      '⏳ Your transfer is being processed.',
      '',
      '📱 /menu for other services.'
    ].join('\n');
    await this.bot.sendMessage(chatId, successMsg, { parse_mode: 'HTML' });
  }

  async extractFile(msg) {
    const doc = msg.document;
    const photos = msg.photo;
    
    if (doc) {
      return { id: doc.file_id, size: doc.file_size, mime: doc.mime_type || 'application/octet-stream', name: doc.file_name || 'file' };
    } else if (Array.isArray(photos) && photos.length) {
      const best = photos[photos.length - 1];
      return { id: best.file_id, size: best.file_size, mime: 'image/jpeg', name: 'photo.jpg' };
    }
    return null;
  }

  async downloadFile(fileId) {
    const fileUrl = await this.bot.getFileLink(fileId);
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
        return Buffer.from(response.data);
      } catch (e) {
        lastErr = e;
        console.warn('[transfer] downloadFile retry', { attempt, error: e?.message });
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    throw lastErr || new Error('download failed');
  }
}
