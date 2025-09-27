export class UtilService {
    static async withLoader(bot, chatId, text, workFn) {
      const loading = await bot.sendMessage(chatId, `⏳ ${text}`);
      try {
        await bot.sendChatAction(chatId, 'typing');
        const result = await workFn();
        try { await bot.deleteMessage(chatId, loading.message_id); } catch {}
        return result;
      } catch (err) {
        try {
          await bot.editMessageText(
            `❌ ${err?.error || err?.message || 'Erreur'}`,
            { chat_id: chatId, message_id: loading.message_id }
          );
        } catch {}
        throw err;
      }
    }
  
    // Optional: consistent short date for recent exchanges
    static formatDT(iso) {
      const d = new Date(iso);
      if (!iso || isNaN(d)) return '';
      const day = d.getDate().toString().padStart(2, '0');
      const month = d.toLocaleString('en-GB', { month: 'short' });
      const year = d.getFullYear();
      let hrs = d.getHours();
      const ampm = hrs >= 12 ? 'pm' : 'am';
      hrs = hrs % 12;
      if (hrs === 0) hrs = 12;
      const hh = hrs.toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      return `${day} ${month} ${year} --${hh}:${mm}${ampm}`;
    }
  }