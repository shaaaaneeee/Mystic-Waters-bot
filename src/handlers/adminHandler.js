// src/handlers/adminHandler.js
/**
 * ADMIN COMMANDS
 * ─────────────────────────────────────────────────────────────────
 * All commands work via DM to the bot (not in the channel).
 * They are protected by the adminOnly middleware.
 *
 * Commands:
 *
 *   /newproduct
 *     Starts a conversation to link a product to a channel post.
 *     Admin provides: post URL or message_id, name, price, quantity.
 *
 *   /stock
 *     Lists all active/sold_out products with remaining stock.
 *
 *   /claims <message_id>
 *     Shows all claimed users for a specific product post.
 *
 *   /invoice <telegram_id>
 *     Sends an invoice to a specific user.
 *
 *   /invoiceall
 *     Sends invoices to ALL users with pending claims.
 *
 *   /pending
 *     Shows summary of all uninvoiced claims.
 */

import { ProductModel } from '../models/product.js';
import { InvoiceModel } from '../models/invoice.js';
import { UserModel } from '../models/user.js';
import {
  sendInvoiceToUser,
  sendAllPendingInvoices,
} from '../services/invoiceService.js';

// ── /newproduct ───────────────────────────────────────────────────
// Usage: /newproduct <message_id> <price> <quantity> <name...>
// Example: /newproduct 42 12.50 3 Blue Tang Fish
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

  // Check for duplicate
  const existing = await ProductModel.findByMessageId(messageId);
  if (existing) {
    return ctx.reply(`⚠️ Post #${messageId} is already registered as: *${existing.name}*`, {
      parse_mode: 'Markdown',
    });
  }

  const product = await ProductModel.create({
    telegramMessageId: messageId,
    name,
    price,
    quantity,
  });

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

  if (products.length === 0) {
    return ctx.reply('No active listings.');
  }

  const lines = products.map(p => {
    const statusEmoji = p.status === 'sold_out' ? '🔴' : '🟢';
    return (
      `${statusEmoji} *${p.name}* (Post #${p.telegram_message_id})\n` +
      `   $${parseFloat(p.price).toFixed(2)} · ` +
      `${p.quantity_remaining}/${p.quantity_total} left · ` +
      `${p.confirmed_claims} claimed`
    );
  });

  return ctx.reply(
    `📦 *Stock Overview*\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
}

// ── /claims <message_id> ─────────────────────────────────────────
export async function handleViewClaims(ctx) {
  const args = ctx.message.text.split(' ');
  const rawMsgId = args[1];

  if (!rawMsgId) {
    return ctx.reply('Usage: /claims <message\\_id>', { parse_mode: 'Markdown' });
  }

  const messageId = parseInt(rawMsgId, 10);
  const product = await ProductModel.findByMessageId(messageId);

  if (!product) {
    return ctx.reply(`❌ No product found for post #${messageId}`);
  }

  const claimedUsers = await ProductModel.getClaimedUsers(product.id);

  if (claimedUsers.length === 0) {
    return ctx.reply(`No claims yet for *${product.name}*`, { parse_mode: 'Markdown' });
  }

  const lines = claimedUsers.map((u, i) => {
    const handle = u.username ? `@${u.username}` : u.first_name || `ID:${u.telegram_id}`;
    const when = new Date(u.claimed_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return `  ${i + 1}. ${handle} — ${when}`;
  });

  return ctx.reply(
    `📋 *Claims for ${product.name}*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}

// ── /invoice <@username | telegram_id> ───────────────────────────
export async function handleSendInvoice(ctx) {
  const args = ctx.message.text.split(' ');
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
    const invoice = await sendInvoiceToUser(ctx.telegram, telegramId);

    if (!invoice) {
      return ctx.reply(`ℹ️ No pending claims for ${displayHandle}.`);
    }

    return ctx.reply(
      `✅ Invoice #${invoice.id} sent to ${displayHandle}\n` +
      `Total: $${parseFloat(invoice.total_amount).toFixed(2)}`
    );
  } catch (err) {
    console.error('[adminHandler] sendInvoice error:', err.message);
    const reason = err.message?.includes("bot can't initiate")
      ? `${displayHandle} must send /start to the bot in DM first`
      : err.message;
    return ctx.reply(`❌ Failed to send invoice: ${reason}`);
  }
}

// ── /invoiceall ───────────────────────────────────────────────────
export async function handleSendAllInvoices(ctx) {
  await ctx.reply('📤 Sending invoices to all pending users...');

  const results = await sendAllPendingInvoices(ctx.telegram);

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success);

  let summary = `✅ Sent ${succeeded} invoice(s).`;
  if (failed.length > 0) {
    const failLines = failed.map(f => {
      const reason = f.error?.includes("bot can't initiate")
        ? 'must send /start to the bot in DM first'
        : f.error;
      return `  • ${f.handle} — ${reason}`;
    });
    summary += `\n⚠️ Failed:\n${failLines.join('\n')}`;
  }

  return ctx.reply(summary);
}

// ── /start (admin variant) ────────────────────────────────────────
export function handleAdminStart(ctx) {
  const name = ctx.from?.first_name || 'Admin';
  return ctx.reply(
    `🐠 *Welcome, ${name}!*\n\n` +
    `You're managing *Mystic Waters Bot*. Here's how it works:\n\n` +
    `*Workflow*\n` +
    `1. Post a product to your Telegram channel\n` +
    `2. Forward the post to this DM — bot guides you step by step\n` +
    `3. Buyers comment \`claim\` in the linked discussion group\n` +
    `4. The bot tracks stock atomically — no overselling\n` +
    `5. Invoice buyers when ready: \`/invoiceall\`\n\n` +
    `*Quick Status*\n` +
    `/stock — Current inventory\n` +
    `/pending — Users awaiting invoices\n\n` +
    `Type /help for the full command reference.`,
    { parse_mode: 'Markdown' }
  );
}

// ── /help ─────────────────────────────────────────────────────────
export function handleHelp(ctx) {
  return ctx.reply(
    `📋 *Admin Commands*\n\n` +
    `*Products*\n` +
    `Forward a channel post to this DM → bot walks you through setup\n` +
    `\`/newproduct <msg_id> <price> <qty> <name>\` — manual shortcut\n\n` +
    `*View Status*\n` +
    `/stock — All products + stock levels\n` +
    `/claims <msg\\_id> — Who claimed a product\n` +
    `/pending — Users with uninvoiced claims\n\n` +
    `*Invoicing*\n` +
    `/invoice @username — Invoice one user\n` +
    `/invoiceall — Invoice all pending users`,
    { parse_mode: 'Markdown' }
  );
}

// ── /pending ──────────────────────────────────────────────────────
export async function handlePending(ctx) {
  const rows = await InvoiceModel.getPendingSummary();

  if (rows.length === 0) {
    return ctx.reply('✅ No pending uninvoiced claims.');
  }

  const lines = rows.map(r => {
    const handle = r.username ? `@${r.username}` : r.first_name || `ID:${r.telegram_id}`;
    return `  • ${handle} — ${r.claim_count} item(s) — $${r.total}`;
  });

  return ctx.reply(
    `💰 *Pending Invoices*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}
