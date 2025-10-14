import { callLaravelAPI, uploadMultipart } from './api.js';

export class TransferService {
  constructor(sessions) {
    this.sessions = sessions;
  }

  async fetchWallets(chatId) {
    const session = this.sessions.get(chatId);
    return await callLaravelAPI('/user/bank-transfer/create', chatId, 'GET', {}, { session });
  }

  async fetchBanks(chatId, currencyCode) {
    const session = this.sessions.get(chatId);
    return await callLaravelAPI(`/user/bank-transfer/${currencyCode}/banks`, chatId, 'GET', {}, { session });
  }

  async calculateDetails(chatId, { currency, amount, bank }) {
    const session = this.sessions.get(chatId);
    return await callLaravelAPI('/user/bank-transfer/details', chatId, 'POST', { currency, amount, bank }, { session });
  }

  async submit(chatId, form) {
    const session = this.sessions.get(chatId);
    return await uploadMultipart('/user/bank-transfer', chatId, form, { session });
  }
}
