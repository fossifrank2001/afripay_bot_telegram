import { callLaravelAPI } from './api.js';

export class ExchangeService {
  constructor(sessions) {
    this.sessions = sessions;
  }

  async fetchForm(chatId) {
    const session = this.sessions.get(chatId);
    let res = await callLaravelAPI('/user/util-bot/echange-form', chatId, 'GET', {}, { session });
    return res;
  }

  async submitExchange(chatId, { amount, from_wallet_id, to_currency_id }) {
    const session = this.sessions.get(chatId);
    let res = await callLaravelAPI('/user/exchange-money', chatId, 'POST', { amount, from_wallet_id, to_currency_id }, { session });
    
    return res;
  }

  async simulate(chatId, { amount, currency, to_currency }) {
    const session = this.sessions.get(chatId);
    return await callLaravelAPI('/simulator', chatId, 'POST', { amount, currency, to_currency }, { session });
  }
}
