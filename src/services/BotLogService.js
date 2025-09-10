import { callLaravelAPI, uploadMultipart } from './api.js';
import FormData from 'form-data';

export class BotLogService {
  constructor(sessions, channel = 'telegram') {
    this.sessions = sessions;
    this.channel = channel; // 'telegram' or 'whatsapp'
  }

  // Ensure a conversation exists and optionally bind user_id
  async upsertConversation(chatId, { userId, title } = {}) {
    const session = this.sessions.get(chatId);
    const body = {
      channel: this.channel,
      external_chat_id: String(chatId),
      user_id: userId ?? session?.auth?.user?.id ?? undefined,
      title,
    };
    const res = await callLaravelAPI('/bot/conversations/upsert', chatId, 'POST', body, { session });
    return res;
  }

  // Store a message (incoming/outgoing)
  async storeMessage(chatId, { direction, message_type = 'text', content, payload, external_message_id, sent_at }) {
    const session = this.sessions.get(chatId);
    const body = {
      channel: this.channel,
      external_chat_id: String(chatId),
      direction,
      message_type,
      content,
      payload,
      external_message_id,
      sent_at,
      user_id: session?.auth?.user?.id,
    };
    const res = await callLaravelAPI('/bot/messages', chatId, 'POST', body, { session });
    return res;
  }

  // Upload an attachment and link it to a specific message id
  async uploadAttachment(chatId, messageId, buffer, filename, mime) {
    const session = this.sessions.get(chatId);
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mime });
    return uploadMultipart(`/bot/messages/${messageId}/attachments`, chatId, form, { session });
  }

  // Convenience: store a system log line (no user-facing send)
  async storeSystem(chatId, content, payload) {
    return this.storeMessage(chatId, {
      direction: 'outgoing',
      message_type: 'system',
      content,
      payload,
    });
  }
}
