// src/index.js
import 'dotenv/config';
import { Telegraf, session, Scenes, Markup } from 'telegraf';
import express from 'express';
import { query } from '../config/database.js';

import { commentOnly, adminOnly, isAdmin, registrationRequired } from './middleware/guards.js';
import { handleClaim } from './handlers/claimHandler.js';
import { ProductModel } from './models/product.js';
import {
  handleNewProduct, handleStock, handleViewClaims,
  handleSendInvoice, handleSendAllInvoices, handlePending,
  handleAdminStart, handleHelp,
  handleConfirmPaid, handleDeleteInvoice, handleDeleteInvoiceConfirm,
  handleInvoiceHistory, cancelInvoiceById, confirmPaidById,
  handleAuctionBids, handleEndAuction, handleCancelAuction,
  handleDrawGiveaway, handleGiveawayStats, handleClearGiveaway, handleClearGiveawayConfirm,
  handleListScheduled, handleDeleteScheduled, handleEditScheduled,
  handleAuctions,
} from './handlers/adminHandler.js';
import { generateInvoiceForAdmin } from './services/invoiceService.js';
import redis from '../config/redis.js';
import { newProductWizard, NEW_PRODUCT_WIZARD_ID } from './scenes/newProductWizard.js';
import { newAuctionWizard, NEW_AUCTION_WIZARD_ID } from './modules/auction/auctionWizard.js';
import { newGiveawayWizard, NEW_GIVEAWAY_WIZARD_ID } from './scenes/newGiveawayWizard.js';
import { scheduleWizard, SCHEDULE_WIZARD_ID, initScheduleWizard } from './modules/scheduler/scheduleWizard.js';
import { handleStartForBuyer, handleContactShare } from './modules/registration/registrationService.js';
import { init as initScheduler } from './modules/scheduler/schedulerService.js';
import { InvoiceModel } from './models/invoice.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[Bot] Error for ${ctx.updateType}:`, err.message, err.stack);
});

bot.use(session());
const stage = new Scenes.Stage([
  newProductWizard,
  newAuctionWizard,
  newGiveawayWizard,
  scheduleWizard,
]);
bot.use(stage.middleware());

// ── Admin commands ────────────────────────────────────────────────
bot.command('cancel',          adminOnly, (ctx) => ctx.reply('Nothing to cancel.'));
bot.command('newproduct',      adminOnly, handleNewProduct);
bot.command('stock',           adminOnly, handleStock);
bot.command('claims',          adminOnly, handleViewClaims);
bot.command('invoice',         adminOnly, handleSendInvoice);
bot.command('invoiceall',      adminOnly, handleSendAllInvoices);
bot.command('pending',         adminOnly, handlePending);
bot.command('invoicehistory',  adminOnly, handleInvoiceHistory);
bot.command('confirmpaid',     adminOnly, handleConfirmPaid);
bot.command('deleteinvoice',   adminOnly, handleDeleteInvoice);
bot.command('createauction',   adminOnly, (ctx) => ctx.scene.enter(NEW_AUCTION_WIZARD_ID));
bot.command('auctionbids',     adminOnly, handleAuctionBids);
bot.command('endauction',      adminOnly, handleEndAuction);
bot.command('cancelauction',   adminOnly, handleCancelAuction);
bot.command('newgiveaway',     adminOnly, (ctx) => ctx.scene.enter(NEW_GIVEAWAY_WIZARD_ID));
bot.command('drawgiveaway',    adminOnly, handleDrawGiveaway);
bot.command('giveawaystats',   adminOnly, handleGiveawayStats);
bot.command('cleargiveaway',   adminOnly, handleClearGiveaway);
bot.command('schedulepost',    adminOnly, (ctx) => ctx.scene.enter(SCHEDULE_WIZARD_ID));
bot.command('listscheduled',   adminOnly, handleListScheduled);
bot.command('editscheduled',   adminOnly, handleEditScheduled);
bot.command('deletescheduled', adminOnly, handleDeleteScheduled);
bot.command('help',            adminOnly, handleHelp);

// ── /start ────────────────────────────────────────────────────────
bot.command('start', (ctx) => {
  if (isAdmin(ctx.from?.id)) return handleAdminStart(ctx);
  return handleStartForBuyer(ctx);
});

// ── Inline keyboard callbacks ─────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});

  if (data.startsWith('invoice:paid:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const invoiceId = parseInt(data.split(':')[2], 10);
    return confirmPaidById(ctx, invoiceId);
  }

  if (data.startsWith('invoice:cancel:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const invoiceId = parseInt(data.split(':')[2], 10);
    const invoice   = await InvoiceModel.findById(invoiceId);
    if (!invoice || invoice.status !== 'active') {
      return ctx.reply(`❌ Invoice #${invoiceId} is not active.`);
    }
    return cancelInvoiceById(ctx, invoiceId, 'Cancelled via button');
  }

  if (data.startsWith('forward:product:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const messageId = parseInt(data.split(':')[2], 10);
    return ctx.scene.enter(NEW_PRODUCT_WIZARD_ID, { messageId });
  }

  if (data.startsWith('forward:auction:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const messageId = parseInt(data.split(':')[2], 10);
    return ctx.scene.enter(NEW_AUCTION_WIZARD_ID, { messageId });
  }

  if (data.startsWith('product:cancel:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const channelPostId = parseInt(data.split(':')[2], 10);
    const product = await ProductModel.findByMessageId(channelPostId);
    if (!product) return ctx.editMessageText('⚠️ Product not found.');
    if (product.status === 'cancelled') return ctx.editMessageText('⚠️ Already cancelled.');
    await ProductModel.cancel(product.id);
    return ctx.editMessageText(
      `🗑️ *${product.name}* (Post #${channelPostId}) has been marked as cancelled.\n\nRemember to delete the post from the channel manually.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ── Contact sharing (registration) ───────────────────────────────
bot.on('contact', (ctx) => {
  if (ctx.message?.chat?.type !== 'private') return;
  return handleContactShare(ctx);
});

// ── Forward channel post in admin DM → choose product or auction ──
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  if (msg.chat.type !== 'private') return next();
  if (!isAdmin(ctx.from?.id)) return next();

  const fwdChatId     = msg.forward_from_chat?.id;
  const isFromChannel = fwdChatId && String(fwdChatId) === String(process.env.CHANNEL_ID);
  if (!isFromChannel) return next();

  const messageId = msg.forward_from_message_id;
  if (!messageId) return ctx.reply('⚠️ Could not read the post ID from that forwarded message.');

  const { rows } = await query(
    'SELECT post_type FROM post_registry WHERE telegram_message_id = $1',
    [messageId]
  );
  if (rows[0]) {
    return ctx.reply(
      `⚠️ Post #${messageId} is already registered as a *${rows[0].post_type}*.`,
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply(
    '📬 What type of listing is this?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📦 Fixed-price Product', `forward:product:${messageId}`),
        Markup.button.callback('🔨 Auction', `forward:auction:${messageId}`),
      ],
    ])
  );
});

// ── Admin DM text — CONFIRM flows ─────────────────────────────────
bot.on('message', async (ctx, next) => {
  if (ctx.message?.chat?.type !== 'private') return next();
  if (!isAdmin(ctx.from?.id)) return next();
  if (ctx.message?.entities?.some(e => e.type === 'bot_command')) return next();

  const text = ctx.message?.text?.trim() || '';
  if (text.toUpperCase().startsWith('CONFIRM')) {
    await handleDeleteInvoiceConfirm(ctx);
    await handleClearGiveawayConfirm(ctx);
    return;
  }

  return next();
});

// ── Group text — claim / bid (registration gated) ─────────────────
bot.on('text', (ctx, next) => {
  if (ctx.message?.entities?.some(e => e.type === 'bot_command')) return;
  return next();
}, commentOnly, registrationRequired, handleClaim);

// ── Express + Webhook ─────────────────────────────────────────────
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

  initScheduleWizard(bot);
  await initScheduler(bot);

  const PORT = parseInt(process.env.PORT || '3000', 10);

  if (process.env.NODE_ENV === 'production') {
    const fullWebhookUrl = process.env.WEBHOOK_URL.replace(/\/+$/, '') + WEBHOOK_PATH;
    await bot.telegram.setWebhook(fullWebhookUrl, { secret_token: process.env.WEBHOOK_SECRET });
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
