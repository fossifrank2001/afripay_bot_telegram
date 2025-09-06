export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  get(chatId) {
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, { state: {}, auth: { isAuthed: false } });
    }
    return this.sessions.get(chatId);
  }

  set(chatId, patch) {
    const current = this.get(chatId);
    const next = { ...current, ...patch };
    this.sessions.set(chatId, next);
    return next;
  }

  clear(chatId) {
    this.sessions.delete(chatId);
  }
}
