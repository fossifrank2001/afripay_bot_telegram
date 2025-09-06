import 'dotenv/config';

const {
  TELEGRAM_BOT_TOKEN,
  LARAVEL_BASE_URL,
  PORT = 3000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in environment');
  process.exit(1);
}

export const config = {
  TELEGRAM_BOT_TOKEN,
  LARAVEL_BASE_URL,
  PORT: Number(PORT) || 3000,
};
