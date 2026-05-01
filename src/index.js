// src/index.js
/**
 * MYSTIC WATERS BOT — Entry Point
 * ────────────────────────────────
 * Stack choice: Node.js + Telegraf
 *
 * Why Telegraf over Python/aiogram?
 *   - Native async/await with no GIL concerns for concurrent claims
 *   - Telegraf's middleware chain maps cleanly to Express-style guards
 *   - Smaller operational footprint (no venv, single process)
 *   - ioredis and pg are battle-tested and well-typed
 *   - The team at Mystic Waters likely runs JS already
 *
 * Why webhooks over polling?
 *   - Lower latency (push vs pull)
 *   - No long-polling overhead for a low-to-medium volume shop
 *   - Easier to run behind a reverse proxy (Nginx/Caddy)
 */

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import express from 'express';

import { commentOnly, adminOnly } from './middleware/guards.js';
import { handleClaim }           from './handlers/claimHandler.js';
import {
  handleNewProduct,
  handleStock,
  handleViewClaims,
  handleSendInvoice,
  handleSendAllInvoices,
  handlePending,
} from './handlers/adminHandler.js';
import redis from '../config/redis.js';

// ── Bot setup ────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use((ctx, next) => {
  console.log('[Update]', JSON.stringify(ctx.update, null, 2));
  return next();
});

// ── Global error handler ─────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('[Bot] Error:', err);
});

// ── Comment-based claim listener ─────────────────────────────────
// This fires on any text message in the linked comment group.
// commentOnly middleware filters to channel-post comments only.
bot.on('text', commentOnly, handleClaim);

// ── Admin commands (DM only, protected) ──────────────────────────
bot.command('newproduct', adminOnly, handleNewProduct);
bot.command('stock',      adminOnly, handleStock);
bot.command('claims',     adminOnly, handleViewClaims);
bot.command('invoice',    adminOnly, handleSendInvoice);
bot.command('invoiceall', adminOnly, handleSendAllInvoices);
bot.command('pending',    adminOnly, handlePending);

// ── Help command ──────────────────────────────────────────────────
bot.command('start', (ctx) => {
  ctx.reply(
    '🐠 *Mystic Waters Bot*\n\n' +
    'Comment `claim` on any product post to reserve it!\n\n' +
    'You\'ll receive an invoice once the admin triggers it.',
    { parse_mode: 'Markdown' }
  );
});

// ── Webhook server ────────────────────────────────────────────────
const app = express();
app.use(express.json());

const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res).catch((err) => {
    console.error('[Webhook] handleUpdate error:', err.message);
    res.sendStatus(500);
  });
});

// Health check endpoint
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Bootstrap ─────────────────────────────────────────────────────
async function bootstrap() {
  await redis.connect();

  const PORT = parseInt(process.env.PORT || '3000', 10);
  const WEBHOOK_URL = process.env.WEBHOOK_URL + WEBHOOK_PATH;

  if (process.env.NODE_ENV === 'production') {
    await bot.telegram.setWebhook(WEBHOOK_URL, {
      secret_token: process.env.WEBHOOK_SECRET,
    });
    console.log(`[Bot] Webhook set: ${WEBHOOK_URL}`);

    app.listen(PORT, () => {
      console.log(`[Bot] HTTP server listening on :${PORT}`);
    });
  } else {
    // Development: use long polling (no HTTPS needed)
    console.log('[Bot] Starting in polling mode (development)');
    await bot.launch();
    console.log('[Bot] Polling started');
  }
}

// Graceful shutdown
process.once('SIGINT',  () => { bot.stop('SIGINT');  redis.disconnect(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); redis.disconnect(); });

bootstrap().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

export { bot };
