// src/modules/registration/registrationService.js
import { Markup } from 'telegraf';
import { UserModel } from '../../models/user.js';

const BUYER_WELCOME_UNREGISTERED = `🐠 *Welcome to Mystic Waters*

We sell rare and curated aquatic life — fish, corals, and collectibles — direct from seller to you.

*Tap the button below to register.* It takes 10 seconds and lets you claim items and join auctions.

Once registered:
— Comment \`claim\` on any product post to reserve it
— Comment \`bid [amount]\` on any auction post to place a bid
— The seller will contact you with payment details`;

const BUYER_WELCOME_REGISTERED = `🐠 *You're registered with Mystic Waters.*

— Comment \`claim\` on product posts to reserve items
— Comment \`bid [amount]\` on auction posts to place bids
— The seller will reach out when your order is ready`;

export async function handleStartForBuyer(ctx) {
  const from = ctx.from;

  const user = await UserModel.upsertAndGetStatus({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
  });

  if (user.registration_status === 'registered') {
    return ctx.reply(BUYER_WELCOME_REGISTERED, { parse_mode: 'Markdown' });
  }

  return ctx.reply(BUYER_WELCOME_UNREGISTERED, {
    parse_mode: 'Markdown',
    ...Markup.keyboard([
      [Markup.button.contactRequest('📱 Share Contact to Register')],
    ]).resize().oneTime(),
  });
}

export async function handleContactShare(ctx) {
  const contact = ctx.message?.contact;
  if (!contact) return;

  // Telegram only delivers contacts the user themselves shared
  if (contact.user_id !== ctx.from?.id) return;

  const updated = await UserModel.setRegistered({
    telegramId: ctx.from.id,
    phoneNumber: contact.phone_number,
  });

  if (!updated) {
    return ctx.reply('⚠️ Something went wrong. Please try again.', Markup.removeKeyboard());
  }

  return ctx.reply(
    `✅ *You're registered!*\n\nYou can now claim products and place bids in the group.\n\nHappy hunting 🐠`,
    { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
  );
}
