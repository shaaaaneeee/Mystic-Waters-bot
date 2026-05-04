// src/services/invoiceService.js
import { Markup } from 'telegraf';
import { ClaimModel } from '../models/claim.js';
import { InvoiceModel } from '../models/invoice.js';
import { UserModel } from '../models/user.js';

const PAYNOW_NUMBER      = '97296056';
const BUSINESS_NAME      = 'Mystic Waters';
const SELFCOLLECT_POSTAL = '520381';
const MAIL_FEE           = 3.50;
const PAYMENT_HOURS      = 24;

function formatSGT(date) {
  return new Date(date).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatInvoiceMessage(user, claims, invoiceId) {
  const name = user.first_name || user.username || 'there';
  const itemLines = claims
    .map((c, i) => `${i + 1}. ${c.name} — $${parseFloat(c.price).toFixed(2)}`)
    .join('\n');
  const total = claims.reduce((s, c) => s + parseFloat(c.price), 0);
  const postRefs = [...new Set(claims.map(c => `#${c.telegram_message_id}`))].join(', ');

  const buyerBlock = [
    `Hi ${name}! You got:`,
    '',
    itemLines,
    '',
    `Your total is $${total.toFixed(2)}.`,
    '',
    'You may:',
    `1. Add $${MAIL_FEE.toFixed(2)} for mail.`,
    `2. Self collect at ${SELFCOLLECT_POSTAL}.`,
    `3. Choose to hold for a reasonable amount of time.`,
    '',
    `Note: Payment has to be made in ${PAYMENT_HOURS} hours.`,
    '',
    `Can pn/pl to ${PAYNOW_NUMBER} (Ardi).`,
    '',
    `Thank you for supporting ${BUSINESS_NAME}!`,
  ].join('\n');

  const adminMeta = [
    '───────────────',
    `📋 Invoice #${invoiceId}`,
    `👤 @${user.username || 'no_username'} (ID: ${user.telegram_id})`,
    `💰 Status: Active`,
    `🕐 Generated: ${formatSGT(new Date())} SGT`,
    `📦 Posts: ${postRefs}`,
  ].join('\n');

  return `${buyerBlock}\n\n${adminMeta}`;
}

export function invoiceKeyboard(invoiceId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Mark as Paid', `invoice:paid:${invoiceId}`),
      Markup.button.callback('❌ Cancel Invoice', `invoice:cancel:${invoiceId}`),
    ],
  ]);
}

// Generates invoice and sends to admin DM only. Returns invoice or null if no pending claims.
export async function generateInvoiceForAdmin(bot, adminTelegramId, telegramUserId) {
  const user = await UserModel.findByTelegramId(telegramUserId);
  if (!user) throw new Error(`User not found: telegramId=${telegramUserId}`);

  const claims = await ClaimModel.getPendingInvoiceClaims(user.id);
  if (claims.length === 0) return null;

  const invoice = await InvoiceModel.createWithClaims({ userId: user.id, claims });
  const message = formatInvoiceMessage(user, claims, invoice.id);

  try {
    await bot.sendMessage(adminTelegramId, message, {
      ...invoiceKeyboard(invoice.id),
    });
  } catch (err) {
    await InvoiceModel.deleteById(invoice.id);
    throw err;
  }

  await InvoiceModel.markSent(invoice.id);
  return invoice;
}

// Generates invoices for all pending users — sends each to admin DM only.
export async function generateAllInvoicesForAdmin(bot, adminTelegramId) {
  const pending = await InvoiceModel.getPendingSummary();
  const results = [];

  for (const row of pending) {
    const handle = row.username ? `@${row.username}` : (row.first_name || `ID:${row.telegram_id}`);
    try {
      const invoice = await generateInvoiceForAdmin(bot, adminTelegramId, row.telegram_id);
      results.push({ handle, success: true, invoice });
    } catch (err) {
      results.push({ handle, success: false, error: err.message });
    }
  }

  return results;
}

// Aliases so existing import sites don't break during transition
export { generateInvoiceForAdmin as sendInvoiceToUser };
export { generateAllInvoicesForAdmin as sendAllPendingInvoices };
