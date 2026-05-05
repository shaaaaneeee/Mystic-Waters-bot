// src/handlers/adminHandler.js
import { Markup } from 'telegraf';
import { query } from '../../config/database.js';
import { buildPageMessage } from '../utils/paginator.js';
import { ProductModel } from '../models/product.js';
import { InvoiceModel } from '../models/invoice.js';
import { UserModel } from '../models/user.js';
import { AuctionModel } from '../models/auction.js';
import { AuctionBidModel } from '../models/auctionBid.js';
import { GiveawayModel } from '../models/giveaway.js';
import { GiveawayService } from '../modules/giveaway/giveawayService.js';
import { ScheduledPostModel } from '../models/scheduledPost.js';
import { generateInvoiceForAdmin, generateAllInvoicesForAdmin } from '../services/invoiceService.js';

// ── /newproduct ───────────────────────────────────────────────────
export async function handleNewProduct(ctx) {
  const args = ctx.message.text.split(' ').slice(1);

  if (args.length < 4) {
    return ctx.reply(
      '📦 Usage: /newproduct <message\\_id> <price> <quantity> <product name...>\n\n' +
      'Example:\n`/newproduct 42 12.50 3 Blue Tang Fish`',
      { parse_mode: 'Markdown' }
    );
  }

  const [rawMsgId, rawPrice, rawQty, ...nameParts] = args;
  const messageId = parseInt(rawMsgId, 10);
  const price     = parseFloat(rawPrice);
  const quantity  = parseInt(rawQty, 10);
  const name      = nameParts.join(' ');

  if (isNaN(messageId) || isNaN(price) || isNaN(quantity) || !name) {
    return ctx.reply('❌ Invalid arguments. Check the format and try again.');
  }

  const existing = await ProductModel.findByMessageId(messageId);
  if (existing) {
    return ctx.reply(`⚠️ Post #${messageId} is already registered as: *${existing.name}*`, {
      parse_mode: 'Markdown',
    });
  }

  const product = await ProductModel.create({ telegramMessageId: messageId, name, price, quantity });

  await query(
    `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
     VALUES ($1, 'product', $2) ON CONFLICT DO NOTHING`,
    [messageId, product.id]
  );

  return ctx.reply(
    `✅ Product registered!\n\n` +
    `*${product.name}*\n` +
    `Price: $${parseFloat(product.price).toFixed(2)}\n` +
    `Stock: ${product.quantity_total} unit(s)\n` +
    `Post ID: ${product.telegram_message_id}`,
    { parse_mode: 'Markdown' }
  );
}

// ── /stock ────────────────────────────────────────────────────────
export async function handleStock(ctx) {
  const products = await ProductModel.listActive();
  if (products.length === 0) return ctx.reply('No active listings.');

  const lines = products.map(p => {
    const statusEmoji = p.status === 'sold_out' ? '🔴' : '🟢';
    return (
      `${statusEmoji} *${p.name}* (Post #${p.telegram_message_id})\n` +
      `   $${parseFloat(p.price).toFixed(2)} · ` +
      `${p.quantity_remaining}/${p.quantity_total} left · ` +
      `${p.confirmed_claims} claimed`
    );
  });

  return ctx.reply(`📦 *Stock Overview*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
}

// ── /claims <message_id> ─────────────────────────────────────────
export async function handleViewClaims(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: /claims <message\\_id>', { parse_mode: 'Markdown' });

  const messageId    = parseInt(rawMsgId, 10);
  const product      = await ProductModel.findByMessageId(messageId);
  if (!product) return ctx.reply(`❌ No product found for post #${messageId}`);

  const claimedUsers = await ProductModel.getClaimedUsers(product.id);
  if (claimedUsers.length === 0) {
    return ctx.reply(`No claims yet for *${product.name}*`, { parse_mode: 'Markdown' });
  }

  const lines = claimedUsers.map((u, i) => {
    const handle = u.username ? `@${u.username}` : u.first_name || `ID:${u.telegram_id}`;
    const when   = new Date(u.claimed_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return `  ${i + 1}. ${handle} — ${when}`;
  });

  return ctx.reply(
    `📋 *Claims for ${product.name}*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}

// ── /invoice <@username | telegram_id> ───────────────────────────
export async function handleSendInvoice(ctx) {
  const args  = ctx.message.text.split(' ');
  const rawId = args[1];

  if (!rawId) {
    return ctx.reply(
      'Usage: `/invoice @username` or `/invoice <telegram_id>`',
      { parse_mode: 'Markdown' }
    );
  }

  let telegramId;
  let displayHandle = rawId;

  if (rawId.startsWith('@')) {
    const user = await UserModel.findByUsername(rawId);
    if (!user) {
      return ctx.reply(`❌ No user found with username ${rawId}.\nThey must have claimed at least once.`);
    }
    telegramId = user.telegram_id;
  } else {
    telegramId = parseInt(rawId, 10);
    if (isNaN(telegramId)) {
      return ctx.reply('❌ Invalid input. Use `@username` or a numeric Telegram ID.', { parse_mode: 'Markdown' });
    }
  }

  try {
    const invoice = await generateInvoiceForAdmin(ctx.telegram, ctx.from.id, telegramId);
    if (!invoice) return ctx.reply(`ℹ️ No pending claims for ${displayHandle}.`);
    return ctx.reply(`✅ Invoice #${invoice.id} generated above for ${displayHandle}.`);
  } catch (err) {
    console.error('[adminHandler] invoice error:', err.message);
    const reason = err.message?.includes("bot can't initiate")
      ? `${displayHandle} must send /start to the bot first`
      : err.message;
    return ctx.reply(`❌ Failed to generate invoice: ${reason}`);
  }
}

// ── /invoiceall ───────────────────────────────────────────────────
export async function handleSendAllInvoices(ctx) {
  await ctx.reply('📤 Generating invoices for all pending users...');
  const results   = await generateAllInvoicesForAdmin(ctx.telegram, ctx.from.id);
  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success);

  let summary = `✅ Generated ${succeeded} invoice(s).`;
  if (failed.length > 0) {
    const failLines = failed.map(f => `  • ${f.handle} — ${f.error}`);
    summary += `\n⚠️ Failed:\n${failLines.join('\n')}`;
  }
  return ctx.reply(summary);
}

// ── /pending ──────────────────────────────────────────────────────
export async function handlePending(ctx) {
  const rows = await InvoiceModel.getPendingSummary();
  if (rows.length === 0) return ctx.reply('✅ No pending uninvoiced claims.');

  const lines = rows.map(r => {
    const handle = r.username ? `@${r.username}` : r.first_name || `ID:${r.telegram_id}`;
    return `  • ${handle} — ${r.claim_count} item(s) — $${r.total}`;
  });

  return ctx.reply(`💰 *Pending Invoices*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

// ── /invoicehistory ───────────────────────────────────────────────
export async function handleInvoiceHistory(ctx) {
  const rows = await InvoiceModel.listHistory();
  if (rows.length === 0) return ctx.reply('No invoice history yet.');

  const lines = rows.map(r => {
    const handle = r.username ? `@${r.username}` : (r.first_name || `ID:${r.telegram_id}`);
    const emoji  = r.status === 'paid' ? '✅' : '❌';
    const date   = new Date(r.updated_at).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });
    return `${emoji} #${r.id} — ${handle} — $${parseFloat(r.total_amount).toFixed(2)} — ${date}`;
  });

  return ctx.reply(`📋 *Invoice History* (last 50)\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

// ── /confirmpaid <invoice_id> ─────────────────────────────────────
export async function handleConfirmPaid(ctx) {
  const args  = ctx.message.text.split(' ');
  const rawId = args[1];
  if (!rawId) return ctx.reply('Usage: `/confirmpaid <invoice_id>`', { parse_mode: 'Markdown' });

  const invoiceId = parseInt(rawId, 10);
  if (isNaN(invoiceId)) return ctx.reply('❌ Invalid invoice ID.');

  return confirmPaidById(ctx, invoiceId);
}

export async function confirmPaidById(ctx, invoiceId) {
  const invoice = await InvoiceModel.confirmPaid({
    invoiceId,
    confirmedByTelegramId: ctx.from.id,
  });

  if (!invoice) {
    return ctx.reply(`❌ Invoice #${invoiceId} not found, already paid, or cancelled.`);
  }

  try {
    const activePool = await GiveawayModel.getActivePool();
    if (activePool) {
      const claims = await InvoiceModel.getClaimsForInvoice(invoiceId);
      await GiveawayService.addEntries({
        pool: activePool,
        invoiceId,
        claims,
        userId: invoice.user_id,
      });
    }
  } catch (err) {
    console.error('[adminHandler] giveaway entry error:', err.message);
  }

  const ts = new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
  const msg = `✅ Invoice #${invoiceId} marked as *paid*.\nConfirmed at ${ts} SGT.`;
  const opts = { parse_mode: 'Markdown' };
  return ctx.callbackQuery
    ? ctx.editMessageText(msg, opts)
    : ctx.reply(msg, opts);
}

// ── /deleteinvoice <invoice_id> ────────────────────────────────────
const PENDING_CANCEL = new Map(); // key: adminTelegramId string → { invoiceId, ts }

export async function handleDeleteInvoice(ctx) {
  const args  = ctx.message.text.split(' ');
  const rawId = args[1];
  if (!rawId) return ctx.reply('Usage: `/deleteinvoice <invoice_id>`', { parse_mode: 'Markdown' });

  const invoiceId = parseInt(rawId, 10);
  if (isNaN(invoiceId)) return ctx.reply('❌ Invalid invoice ID.');

  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) return ctx.reply(`❌ Invoice #${invoiceId} not found.`);
  if (invoice.status !== 'active') {
    return ctx.reply(
      `❌ Invoice #${invoiceId} is already *${invoice.status}*. Only active invoices can be cancelled.`,
      { parse_mode: 'Markdown' }
    );
  }

  const handle = invoice.username
    ? `@${invoice.username}`
    : (invoice.first_name || `ID:${invoice.telegram_id}`);

  PENDING_CANCEL.set(`${ctx.from.id}`, { invoiceId, ts: Date.now() });

  return ctx.reply(
    `⚠️ Cancel invoice #${invoiceId} for ${handle} ($${parseFloat(invoice.total_amount).toFixed(2)})?\n\n` +
    `Reply \`CONFIRM\` to proceed, or ignore to abort.\n` +
    `_Optional: \`CONFIRM reason text\`_`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleDeleteInvoiceConfirm(ctx) {
  const text = ctx.message?.text?.trim() || '';
  if (!text.toUpperCase().startsWith('CONFIRM')) return;

  const key     = `${ctx.from.id}`;
  const pending = PENDING_CANCEL.get(key);
  if (!pending || Date.now() - pending.ts > 120_000) {
    PENDING_CANCEL.delete(key);
    return;
  }

  const { invoiceId } = pending;
  const reason = text.length > 7 ? text.slice(8).trim() : null;
  PENDING_CANCEL.delete(key);

  return cancelInvoiceById(ctx, invoiceId, reason);
}

export async function cancelInvoiceById(ctx, invoiceId, reason) {
  const claims    = await InvoiceModel.getClaimsForInvoice(invoiceId);
  const cancelled = await InvoiceModel.cancel({
    invoiceId,
    cancelledByTelegramId: ctx.from.id,
    reason,
  });

  if (!cancelled) {
    return ctx.reply(`❌ Invoice #${invoiceId} could not be cancelled (not active or not found).`);
  }

  let msg = `✅ Invoice #${invoiceId} cancelled. ${claims.length} claim(s) voided.`;
  if (reason) msg += `\n_Reason: ${reason}_`;

  const opts = { parse_mode: 'Markdown' };
  return ctx.callbackQuery
    ? ctx.editMessageText(msg, opts)
    : ctx.reply(msg, opts);
}

// ── /start (admin variant) ────────────────────────────────────────
export function handleAdminStart(ctx) {
  const name = ctx.from?.first_name || 'Admin';
  return ctx.reply(
    `🐠 *Welcome, ${name}!*\n\n` +
    `You're managing *Mystic Waters Bot*.\n\n` +
    `*Workflow*\n` +
    `1. Post to your channel\n` +
    `2. Forward the post here → choose Product or Auction\n` +
    `3. Buyers register via bot link, then comment in the group\n` +
    `4. Generate invoices: \`/invoice @user\` or \`/invoiceall\`\n` +
    `5. Confirm payment: \`/confirmpaid <id>\`\n\n` +
    `*Quick Status*\n` +
    `/stock · /pending\n\n` +
    `Type /help for the full command reference.`,
    { parse_mode: 'Markdown' }
  );
}

// ── /help ─────────────────────────────────────────────────────────
export function handleHelp(ctx) {
  return ctx.reply(
    `📋 *Admin Command Reference*\n\n` +

    `*📦 Products*\n` +
    `Forward a channel post → choose Product or Auction\n` +
    `\`/newproduct <msg\\_id> <price> <qty> <name>\` — manual\n\n` +

    `*🔨 Auctions*\n` +
    `/createauction — wizard\n` +
    `/auctionbids <post\\_id> — view all bids\n` +
    `/endauction <post\\_id> — force-end early\n` +
    `/cancelauction <post\\_id> — cancel\n\n` +

    `*📊 Status*\n` +
    `/stock — products & stock levels\n` +
    `/pending — uninvoiced claims\n` +
    `/claims <post\\_id> — who claimed a product\n\n` +

    `*🧾 Invoices*\n` +
    `/invoice @username — generate invoice (shown here)\n` +
    `/invoiceall — generate for all pending users\n` +
    `/invoicehistory — paid & cancelled\n` +
    `/confirmpaid <id> — mark as paid\n` +
    `/deleteinvoice <id> — cancel invoice\n\n` +

    `*🎁 Giveaway*\n` +
    `/newgiveaway — start pool\n` +
    `/drawgiveaway — draw winner\n` +
    `/giveawaystats — pool stats\n` +
    `/cleargiveaway — cancel pool\n\n` +

    `*📅 Scheduling*\n` +
    `/schedulepost — schedule a channel post\n` +
    `/listscheduled — pending posts\n` +
    `/editscheduled <id> — reschedule a pending post\n` +
    `/deletescheduled <id> — cancel scheduled post\n\n` +

    `*⚙️ Other*\n` +
    `/start — welcome & workflow\n` +
    `/cancel — exit any wizard\n` +
    `/help — this reference`,
    { parse_mode: 'Markdown' }
  );
}

// ── Auction commands ──────────────────────────────────────────────
export async function handleAuctionBids(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/auctionbids <post_id>`', { parse_mode: 'Markdown' });

  const auction = await AuctionModel.findByMessageId(parseInt(rawMsgId, 10));
  if (!auction) return ctx.reply(`❌ No auction found for post #${rawMsgId}.`);

  const bids = await AuctionBidModel.listForAuction(auction.id);
  if (bids.length === 0) {
    return ctx.reply(`No bids yet for *${auction.name}*.`, { parse_mode: 'Markdown' });
  }

  const lines = bids.map((b, i) => {
    const handle = b.username ? `@${b.username}` : (b.first_name || `ID:${b.telegram_id}`);
    return `  ${i + 1}. ${handle} — $${parseFloat(b.amount).toFixed(2)}${b.is_winning ? ' 👑' : ''}`;
  });

  return ctx.reply(
    `🔨 *Bids for ${auction.name}*\n` +
    `Current: $${auction.current_bid ? parseFloat(auction.current_bid).toFixed(2) : '—'}\n\n` +
    lines.join('\n'),
    { parse_mode: 'Markdown' }
  );
}

export async function handleEndAuction(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/endauction <post_id>`', { parse_mode: 'Markdown' });

  const auction = await AuctionModel.findByMessageId(parseInt(rawMsgId, 10));
  if (!auction) return ctx.reply(`❌ No auction found for post #${rawMsgId}.`);
  if (auction.status !== 'active') return ctx.reply(`❌ Auction is not active (status: ${auction.status}).`);

  await AuctionModel.forceEnd(auction.id);
  return ctx.reply(
    `✅ Auction *${auction.name}* force-ended. Will close within 60s.`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleCancelAuction(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/cancelauction <post_id>`', { parse_mode: 'Markdown' });

  const auction   = await AuctionModel.findByMessageId(parseInt(rawMsgId, 10));
  if (!auction) return ctx.reply(`❌ No auction found for post #${rawMsgId}.`);

  const cancelled = await AuctionModel.cancel(auction.id);
  if (!cancelled) return ctx.reply(`❌ Could not cancel (status: ${auction.status}).`);

  return ctx.reply(`✅ Auction *${auction.name}* cancelled.`, { parse_mode: 'Markdown' });
}

// ── Giveaway commands ─────────────────────────────────────────────
export async function handleDrawGiveaway(ctx) {
  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active giveaway pool. Start one with /newgiveaway.');

  const stats = await GiveawayModel.getPoolStats(pool.id);
  if (stats.total_entries === 0) {
    return ctx.reply(`❌ Pool *${pool.title}* has no entries yet.`, { parse_mode: 'Markdown' });
  }

  const winnerEntry = await GiveawayModel.drawWinner({ poolId: pool.id, drawnBy: ctx.from.id });
  if (!winnerEntry) return ctx.reply('❌ Could not draw winner.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [winnerEntry.user_id]);
  const w      = rows[0];
  const handle = w ? (w.username ? `@${w.username}` : (w.first_name || `ID:${w.telegram_id}`)) : 'Unknown';

  return ctx.reply(
    `🎉 *Winner Drawn!*\n\n` +
    `*${pool.title}*\n` +
    `Prize: ${pool.prize_description || '_not specified_'}\n\n` +
    `Winner: *${handle}*\n` +
    `Drawn from ${stats.total_entries} entries · ${stats.unique_users} participants.\n\n` +
    `Pool closed. Start a new one with /newgiveaway.`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleGiveawayStats(ctx) {
  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active giveaway pool.');

  const stats = await GiveawayModel.getPoolStats(pool.id);
  const top   = await GiveawayModel.getTopContributors(pool.id);

  const topLines = top.map((u, i) => {
    const handle = u.username ? `@${u.username}` : (u.first_name || `ID:${u.telegram_id}`);
    return `  ${i + 1}. ${handle} — ${u.entries} entr${u.entries === 1 ? 'y' : 'ies'}`;
  });

  return ctx.reply(
    `🎁 *${pool.title}*\n` +
    (pool.prize_description ? `Prize: ${pool.prize_description}\n` : '') +
    `\nTotal entries: *${stats.total_entries}*\n` +
    `Unique participants: *${stats.unique_users}*\n\n` +
    (topLines.length ? `*Top Contributors:*\n${topLines.join('\n')}` : '_No entries yet._'),
    { parse_mode: 'Markdown' }
  );
}

const PENDING_CLEAR = new Map(); // key: adminTelegramId string → ts

export async function handleClearGiveaway(ctx) {
  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active giveaway pool to clear.');

  PENDING_CLEAR.set(`${ctx.from.id}`, Date.now());

  return ctx.reply(
    `⚠️ Cancel giveaway pool *${pool.title}* without drawing a winner?\n\nReply \`CONFIRM\` to proceed.`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleClearGiveawayConfirm(ctx) {
  const text = ctx.message?.text?.trim() || '';
  if (text !== 'CONFIRM') return;

  const key = `${ctx.from.id}`;
  const ts  = PENDING_CLEAR.get(key);
  if (!ts || Date.now() - ts > 120_000) { PENDING_CLEAR.delete(key); return; }
  PENDING_CLEAR.delete(key);

  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active pool to clear.');

  const cancelled = await GiveawayModel.cancelPool(pool.id);
  if (!cancelled) return ctx.reply('❌ Could not cancel pool.');

  return ctx.reply(
    `✅ Giveaway pool *${pool.title}* cancelled. History preserved.`,
    { parse_mode: 'Markdown' }
  );
}

// ── Scheduler commands ────────────────────────────────────────────
export async function handleListScheduled(ctx) {
  const posts = await ScheduledPostModel.listPending();
  if (posts.length === 0) return ctx.reply('No scheduled posts pending.');

  const typeEmoji = { free_form: '📝', product_listing: '📦', auction_listing: '🔨' };
  const lines = posts.map(p => {
    const emoji = typeEmoji[p.type] || '📅';
    const label = p.product_name || p.auction_name
      || (p.content ? p.content.slice(0, 30) + (p.content.length > 30 ? '…' : '') : '—');
    const when  = new Date(p.scheduled_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return `${emoji} #${p.id} — ${label} — ${when} SGT`;
  });

  return ctx.reply(`📅 *Scheduled Posts*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

export async function handleDeleteScheduled(ctx) {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/deletescheduled <id>`', { parse_mode: 'Markdown' });

  const { cancelScheduledPost } = await import('../modules/scheduler/schedulerService.js');
  cancelScheduledPost(id);

  const cancelled = await ScheduledPostModel.cancel(id, 'Cancelled by admin');
  if (!cancelled) return ctx.reply(`❌ Post #${id} not found or already sent/cancelled.`);

  return ctx.reply(`✅ Scheduled post #${id} cancelled.`);
}

export async function handleEditScheduled(ctx) {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/editscheduled <id>`', { parse_mode: 'Markdown' });

  const post = await ScheduledPostModel.findById(id);
  if (!post) return ctx.reply(`❌ Scheduled post #${id} not found.`);
  if (post.status !== 'pending') {
    return ctx.reply(
      `❌ Post #${id} is *${post.status}* — only pending posts can be edited.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Cancel the existing post (in-memory timeout + DB status)
  const { cancelScheduledPost } = await import('../modules/scheduler/schedulerService.js');
  cancelScheduledPost(id);
  await ScheduledPostModel.cancel(id, 'Superseded by edit');

  // Build prefill state from existing post so wizard pre-populates
  const prefill = {
    type:          post.type,
    content:       post.content,
    name:          post.product_name || post.auction_name,
    price:         post.product_price         ? parseFloat(post.product_price)         : undefined,
    quantity:      post.product_quantity      ?? undefined,
    description:   post.product_description  || post.auction_description || null,
    startingBid:   post.auction_starting_bid  ? parseFloat(post.auction_starting_bid)  : undefined,
    minIncrement:  post.auction_min_increment ? parseFloat(post.auction_min_increment) : undefined,
    auctionEndTime: post.auction_end_time     ? new Date(post.auction_end_time)         : undefined,
  };

  await ctx.reply(`✏️ Post #${id} cancelled. Opening wizard with existing details — just enter a new time.`);
  return ctx.scene.enter('schedule-post-wizard', { prefill });
}
