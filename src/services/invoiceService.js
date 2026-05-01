// src/services/invoiceService.js
import { ClaimModel } from '../models/claim.js';
import { InvoiceModel } from '../models/invoice.js';
import { UserModel } from '../models/user.js';

const PAYNOW_NUMBER = '97296056';
const BUSINESS_NAME = 'Mystic Waters';
const SELFCOLLECT_POSTAL = '520381';
const MAIL_FEE = 3.50;
const PAYMENT_HOURS = 24;

/**
 * Build the invoice message string for a user.
 */
export function formatInvoice(user, claims, invoiceId) {
  const name = user.first_name || user.username || 'there';
  const itemLines = claims
    .map((c, i) => `  ${i + 1}. ${c.name} — $${parseFloat(c.price).toFixed(2)}`)
    .join('\n');

  const total = claims.reduce((s, c) => s + parseFloat(c.price), 0);

  return [
    `Hi ${name}! You got:`,
    '',
    itemLines,
    '',
    `Your total is *$${total.toFixed(2)}*`,
    '',
    'You may:',
    `  1. Add *$${MAIL_FEE.toFixed(2)}* for mail`,
    `  2. Self collect at ${SELFCOLLECT_POSTAL}`,
    '  3. Choose to hold for a reasonable amount of time',
    '',
    `Note: Payment has to be made within *${PAYMENT_HOURS} hours*`,
    '',
    `Can PayNow to *${PAYNOW_NUMBER}* (Ardi)`,
    '',
    `Thank you for supporting ${BUSINESS_NAME}! 🐠`,
    '',
    `_Invoice #${invoiceId}_`,
  ].join('\n');
}

/**
 * Generate and send an invoice to a single user via Telegram.
 * If the user has no uninvoiced claims, returns null.
 */
export async function sendInvoiceToUser(bot, telegramId) {
  const user = await UserModel.findByTelegramId(telegramId);
  if (!user) throw new Error(`User not found: telegramId=${telegramId}`);

  const claims = await ClaimModel.getPendingInvoiceClaims(user.id);
  if (claims.length === 0) return null;

  const invoice = await InvoiceModel.createWithClaims({
    userId: user.id,
    claims,
  });

  const message = formatInvoice(user, claims, invoice.id);

  await bot.telegram.sendMessage(telegramId, message, {
    parse_mode: 'Markdown',
  });

  await InvoiceModel.markSent(invoice.id);
  return invoice;
}

/**
 * Send invoices to ALL users with pending claims.
 * Returns array of results.
 */
export async function sendAllPendingInvoices(bot) {
  const pending = await InvoiceModel.getPendingSummary();
  const results = [];

  for (const row of pending) {
    try {
      const invoice = await sendInvoiceToUser(bot, row.telegram_id);
      results.push({ telegramId: row.telegram_id, success: true, invoice });
    } catch (err) {
      results.push({ telegramId: row.telegram_id, success: false, error: err.message });
    }
  }

  return results;
}
