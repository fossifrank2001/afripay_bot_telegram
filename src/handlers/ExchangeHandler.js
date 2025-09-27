import { ExchangeService } from '../services/ExchangeService.js';
import { UtilService } from '../utils/loader.js';

export class ExchangeHandler {
  constructor(bot, sessions, authService, botLog) {
    this.bot = bot;
    this.sessions = sessions;
    this.auth = authService;
    this.botLog = botLog;
    this.exchangeService = new ExchangeService(this.sessions);
  }

  async start(msg) {
    const chatId = msg.chat.id;
    const session = this.sessions.get(chatId);
    if (!session?.auth?.isAuthed) {
      await this.bot.sendMessage(chatId, "Veuillez vous connecter d'abord avec /login");
      return;
    }

    await this.bot.sendChatAction(chatId, 'typing');
    const form = await UtilService.withLoader(this.bot, chatId, 'Récupération du formulaire…', async () => {
        return await this.exchangeService.fetchForm(chatId);
    });
    if (form?.error) {
      try { await this.botLog?.storeSystem(chatId, 'exchange_form_failed', { error: form.error }); } catch {}
      await this.bot.sendMessage(chatId, `❌ Impossible de récupérer le formulaire d'échange: ${form.error}`);
      return;
    }

    const wallets = (form.wallets || form.response?.wallets || []).map(w => ({
      id: w.id,
      code: w.currency?.code,
      curr_id: w.currency?.id,
      rate: Number(w.currency?.rate || 1),
      balance: Number(w.balance || 0),
      type: w.currency?.type,
    }));

    const currencies = (form.currencies || form.response?.currencies || []).map(c => ({
      id: c.id,
      code: c.code,
      rate: Number(c.rate || 1),
      type: c.type,
    }));

    const charge = form.charge || form.response?.charge || { fixed_charge: 0, percent_charge: 0 };

    const recentItems = (form.recent_exchanges || form.response?.recent_exchanges || []).slice(0, 3);
    const recents = recentItems.map(e => {
      const fromCode = e?.fromCurr?.code || currencies.find(c => String(c.id) === String(e.from_currency))?.code || '?';
      const toCode = e?.toCurr?.code || currencies.find(c => String(c.id) === String(e.to_currency))?.code || '?';
      const fromAmt = Number(e.from_amount ?? 0).toFixed(2);
      const toAmt = Number(e.to_amount ?? 0).toFixed(2);
      const when = UtilService.formatDT(e?.created_at);
      return `▫️ ${fromCode} ${fromAmt} → ${toCode} ${toAmt}${when ? ` | ${when}` : ''}`;
    }).join('\n');

    const intro = ['💱 Exchange', recents ? `Derniers échanges:\n${recents}` : null].filter(Boolean).join('\n\n');
    await this.bot.sendMessage(chatId, intro || '💱 Exchange');

    if (!wallets.length) {
      await this.bot.sendMessage(chatId, 'Aucun wallet disponible avec solde positif.');
      return;
    }

    // Save flow state in session
    session.exchange = { step: 'amount', wallets, currencies, charge };
    this.sessions.set(chatId, session);

    await this.bot.sendMessage(chatId, 'Entrez le montant à échanger (ex: 200):');
    this.bot.once('message', (m) => this._handleAmount(chatId, m));
  }

  async _handleAmount(chatId, msg) {
    const session = this.sessions.get(chatId);
    const flow = session?.exchange;
    if (!flow) return;

    const amount = parseFloat((msg.text || '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      try { await this.botLog?.storeSystem(chatId, 'exchange_amount_invalid', { input: msg.text }); } catch {}
      await this.bot.sendMessage(chatId, 'Montant invalide. Relancez /exchange pour recommencer.');
      return;
    }

    flow.amount = amount;
    flow.step = 'from';
    this.sessions.set(chatId, session);

    const list = flow.wallets.map((w, i) => `${i + 1}) ${w.code} | Solde: ${w.balance.toFixed(2)}`).join('\n');
    await this.bot.sendMessage(chatId, `Choisissez le wallet source (From Currency):\n${list}\n\nEnvoyez le numéro (ex: 1).`);
    this.bot.once('message', (m) => this._handleFrom(chatId, m));
  }

  async _handleFrom(chatId, msg) {
    const session = this.sessions.get(chatId);
    const flow = session?.exchange;
    if (!flow) return;

    const idx = parseInt((msg.text || '').trim(), 10) - 1;
    const from = flow.wallets[idx];
    if (!from) {
      try { await this.botLog?.storeSystem(chatId, 'exchange_from_invalid', { input: msg.text }); } catch {}
      await this.bot.sendMessage(chatId, 'Choix invalide. Relancez /exchange pour recommencer.');
      return;
    }

    flow.from = from;
    flow.step = 'to';
    this.sessions.set(chatId, session);

    const toList = flow.currencies
      .filter(c => String(c.id) !== String(from.curr_id))
      .map((c, i) => `${i + 1}) ${c.code}`)
      .join('\n');

    await this.bot.sendMessage(chatId, `Choisissez la devise cible (To Currency):\n${toList}\n\nEnvoyez le numéro (ex: 1).`);
    this.bot.once('message', (m) => this._handleTo(chatId, m));
  }

  async _handleTo(chatId, msg) {
    const session = this.sessions.get(chatId);
    const flow = session?.exchange;
    if (!flow) return;

    const candidates = flow.currencies.filter(c => String(c.id) !== String(flow.from.curr_id));
    const idx = parseInt((msg.text || '').trim(), 10) - 1;
    const to = candidates[idx];
    if (!to) {
      try { await this.botLog?.storeSystem(chatId, 'exchange_to_invalid', { input: msg.text }); } catch {}
      await this.bot.sendMessage(chatId, 'Choix invalide. Relancez /exchange pour recommencer.');
      return;
    }

    flow.to = to;
    flow.step = 'confirm';
    this.sessions.set(chatId, session);

    let resume;
    try {
    const sim = await UtilService.withLoader(this.bot, chatId, 'Calcul de la simulation…', async () => {
        return await this.exchangeService.simulate(chatId, {
            amount: flow.amount,
            currency: flow.from.code,
            to_currency: to.code,
        });
    });

    console.log('Simulator response ::: ', sim);

    // Journaliser la réponse brute pour debug
    try { await this.botLog?.storeSystem(chatId, 'exchange_simulator_response', sim); } catch {}

    // Normaliser la structure: on gère {fees,...}, {data:{...}}, {response:{...}}, ou imbriqués
    const root = sim?.data || sim?.response || sim || {};
    const payload = root.response || root.data || root;

    const fees = payload.fees ?? payload?.data?.fees ?? root.fees ?? root?.data?.fees;
    const tva = payload.tva ?? payload?.data?.tva ?? root.tva ?? root?.data?.tva;
    const receiveAmount = payload.receiveAmount ?? payload?.data?.receiveAmount ?? root.receiveAmount ?? root?.data?.receiveAmount;
    const rateText = payload.dollarText ?? payload?.data?.dollarText ?? root.dollarText ?? root?.data?.dollarText;

    // Si malgré tout on n'a pas les valeurs, on signale et on passe en fallback
    if (fees === undefined || receiveAmount === undefined) {
        throw new Error('Simulator payload missing fields');
    }

    resume = [
        `From: ${flow.from.code}`,
        `To: ${to.code}`,
        rateText ? `${rateText}` : null,
        `Exchange Amount: ${flow.amount} ${flow.from.code}`,
        `Exchange Charge: ${fees} ${flow.from.code}`,
        tva ? `TVA: ${tva} ${flow.from.code}` : null,
        `Will get: ${receiveAmount} ${to.code}`,
    ].filter(Boolean).join('\n');

    } catch (e) {
    // Fallback local si le simulateur échoue/renvoie un format inattendu
    const amount = flow.amount;
    const fromRate = flow.from.rate || 1;
    const toRate = to.rate || 1;
    const defaultAmount = amount / fromRate;
    const willGet = defaultAmount * toRate;
    const fixed = Number(flow.charge?.fixed_charge || 0) * fromRate;
    const percent = Number(flow.charge?.percent_charge || 0);
    const exCharge = fixed + amount * (percent / 100);

    try { await this.botLog?.storeSystem(chatId, 'exchange_simulator_fallback', { error: e?.message }); } catch {}

    resume = [
        `From: ${flow.from.code}`,
        `To: ${to.code}`,
        `Amount: ${amount} ${flow.from.code}`,
        `Charge: ${exCharge.toFixed(2)} ${flow.from.code}`,
        `Will get: ${willGet.toFixed(2)} ${to.code}`,
    ].join('\n');
    }

    await this.bot.sendMessage(chatId, `${resume}\n\nEntrez votre PIN (6 chiffres) pour confirmer:`);
    this.bot.once('message', (m) => this._handlePin(chatId, m));
  }

  async _handlePin(chatId, msg) {
    const session = this.sessions.get(chatId);
    const flow = session?.exchange;
    if (!flow) return;

    // initialize attempts counter
    if (typeof flow.pinAttempts !== 'number') flow.pinAttempts = 0;

    const pin = (msg.text || '').trim();
    if (!/^\d{6}$/.test(pin)) {
      flow.pinAttempts += 1;
      this.sessions.set(chatId, session);

      if (flow.pinAttempts >= 3) {
        try { await this.botLog?.storeSystem(chatId, 'exchange_pin_invalid_max_reached'); } catch {}
        await this.bot.sendMessage(chatId, "❌ Nombre maximum de tentatives atteint. Veuillez relancer /exchange.");
        delete session.exchange;
        this.sessions.set(chatId, session);
        return;
      }

      const remaining = 3 - flow.pinAttempts;
      try { await this.botLog?.storeSystem(chatId, 'exchange_pin_invalid_attempt', { attempts: flow.pinAttempts }); } catch {}
      await this.bot.sendMessage(chatId, `PIN invalide. Il vous reste ${remaining} tentative(s). Entrez votre PIN (6 chiffres) :`);
      this.bot.once('message', (m) => this._handlePin(chatId, m));
      return;
    }

    // Verify PIN
    const email = session?.auth?.email;
    const pinRes = await UtilService.withLoader(this.bot, chatId, 'Vérification du PIN…', async () => {
        return await this.auth.verifyPin(chatId, { email, pin });
    });

    if (pinRes?.error) {
      flow.pinAttempts += 1;
      this.sessions.set(chatId, session);

      if (flow.pinAttempts >= 3) {
        try { await this.botLog?.storeSystem(chatId, 'exchange_pin_verify_failed_max', { error: pinRes.error }); } catch {}
        await this.bot.sendMessage(chatId, "❌ Nombre maximum de tentatives atteint. Veuillez relancer /exchange.");
        delete session.exchange;
        this.sessions.set(chatId, session);
        return;
      }

      const remaining = 3 - flow.pinAttempts;
      try { await this.botLog?.storeSystem(chatId, 'exchange_pin_verify_failed', { error: pinRes.error, attempts: flow.pinAttempts }); } catch {}
      await this.bot.sendMessage(chatId, `❌ Vérification PIN échouée: ${pinRes.error}. Il vous reste ${remaining} tentative(s). Entrez de nouveau votre PIN (6 chiffres) :`);
      this.bot.once('message', (m) => this._handlePin(chatId, m));
      return;
    }

    // Reset attempts on success
    flow.pinAttempts = 0;

    // Submit exchange
    await this.bot.sendChatAction(chatId, 'typing');
    const payload = {
      amount: flow.amount,
      from_wallet_id: flow.from.id,
      to_currency_id: flow.to.id,
    };

    const res = await UtilService.withLoader(this.bot, chatId, "Soumission de l'échange…", async () => {
    return await this.exchangeService.submitExchange(chatId, payload);
    });
    if (res?.error) {
      try { await this.botLog?.storeSystem(chatId, 'exchange_submit_failed', { error: res.error }); } catch {}
      await this.bot.sendMessage(chatId, `❌ Échec de l'échange: ${res.error}`);
      return;
    }

    console.log('Echange Service ::: ', res);
    await this.bot.sendMessage(chatId, '✅ Échange effectué avec succès.');
    try { await this.botLog?.storeSystem(chatId, 'exchange_success', payload); } catch {}
    delete session.exchange;
    this.sessions.set(chatId, session);
  }
}