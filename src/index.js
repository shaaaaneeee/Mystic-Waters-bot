// src/index.js
import 'dotenv/config';
import { Telegraf, session, Scenes } from 'telegraf';
import express from 'express';

import { commentOnly, adminOnly, isAdmin } from './middleware/guards.js';
import { handleClaim }           from './handlers/claimHandler.js';
import {
  handleNewProduct,
  handleStock,
  handleViewClaims,
  handleSendInvoice,
  handleSendAllInvoices,
  handlePending,
  handleAdminStart,
  handleHelp,
} from './handlers/adminHandler.js';
import redis from '../config/redis.js';
import { newProductWizard, NEW_PRODUCT_WIZARD_ID } from './scenes/newProductWizard.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[Bot] Error for ${ctx.updateType}:`, err.message, err.stack);
});

bot.use(session());
const stage = new Scenes.Stage([newProductWizard]);
bot.use(stage.middleware());

// ── CRITICAL: Commands registered BEFORE bot.on('text') ──────────
// Telegraf processes handlers in order. bot.on('text') matches ALL
// text including commands. commentOnly drops DMs silently (DM ≠ group).
// Commands must be registered first so they are matched before the text handler.

bot.command('cancel', adminOnly, (ctx) => ctx.reply('Nothing to cancel.'));

bot.command('newproduct', adminOnly, handleNewProduct);
bot.command('stock',      adminOnly, handleStock);
bot.command('claims',     adminOnly, handleViewClaims);
bot.command('invoice',    adminOnly, handleSendInvoice);
bot.command('invoiceall', adminOnly, handleSendAllInvoices);
bot.command('pending',    adminOnly, handlePending);
bot.command('help',       adminOnly, handleHelp);

bot.command('start', (ctx) => {
  if (isAdmin(ctx.from?.id)) return handleAdminStart(ctx);
  return ctx.reply(
    '🐠 *Mystic Waters Bot*\n\nComment `claim` on any product post in the discussion group to reserve it.\n\nYou\'ll receive an invoice via DM once the admin triggers it.',
    { parse_mode: 'Markdown' }
  );
});

// ── Forward channel post in admin DM → enter product wizard ──────────────────
bot.on('message', adminOnly, async (ctx, next) => {
  const msg = ctx.message;
  if (msg.chat.type !== 'private') return next();

  const fwdChatId = msg.forward_from_chat?.id;
  const isFromChannel = fwdChatId &&
    String(fwdChatId) === String(process.env.CHANNEL_ID);
  if (!isFromChannel) return next();

  const messageId = msg.forward_from_message_id;
  if (!messageId) {
    return ctx.reply('⚠️ Could not read the post ID from that forwarded message.');
  }

  return ctx.scene.enter(NEW_PRODUCT_WIZARD_ID, { messageId });
});

// Skip bot_command entities so /commands never reach handleClaim
bot.on('text', (ctx, next) => {
  if (ctx.message?.entities?.some(e => e.type === 'bot_command')) return;
  return next();
}, commentOnly, handleClaim);

const app = express();
app.use(express.json());

const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res).catch((err) => {
    console.error('[Webhook] handleUpdate error:', err.message);
    res.sendStatus(500);
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

async function bootstrap() {
  await redis.connect();

  const me = await bot.telegram.getMe();
  bot.options.username = me.username;
  console.log('[Bot] Username:', me.username);

  const PORT = parseInt(process.env.PORT || '3000', 10);

  if (process.env.NODE_ENV === 'production') {
    // WEBHOOK_URL = base domain only, e.g. https://mystic-waters-bot-production.up.railway.app
    // Do NOT include /webhook in WEBHOOK_URL
    const fullWebhookUrl = process.env.WEBHOOK_URL.replace(/\/+$/, '') + WEBHOOK_PATH;
    await bot.telegram.setWebhook(fullWebhookUrl, {
      secret_token: process.env.WEBHOOK_SECRET,
    });
    console.log(`[Bot] Webhook set: ${fullWebhookUrl}`);
    app.listen(PORT, () => console.log(`[Bot] HTTP server listening on :${PORT}`));
  } else {
    console.log('[Bot] Starting in polling mode (development)');
    await bot.launch();
    console.log('[Bot] Polling started');
  }
}

process.once('SIGINT',  () => { bot.stop('SIGINT');  redis.disconnect(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); redis.disconnect(); });

bootstrap().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

export { bot };
