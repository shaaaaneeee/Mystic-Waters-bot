// src/modules/auction/auctionWizard.js
import { Scenes } from 'telegraf';
import { AuctionModel } from '../../models/auction.js';

export const NEW_AUCTION_WIZARD_ID = 'new-auction-wizard';

function parseSGTDateTime(str) {
  const full  = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  const short = str.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  let day, month, year, hour, minute;
  if (full)       [, day, month, year, hour, minute] = full;
  else if (short) { [, day, month, hour, minute] = short; year = new Date().getFullYear(); }
  else            return null;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  return isNaN(date.getTime()) ? null : date;
}

export const newAuctionWizard = new Scenes.WizardScene(
  NEW_AUCTION_WIZARD_ID,

  // Step 0: entered with { messageId } in wizard state — ask name
  async (ctx) => {
    await ctx.reply(
      '🔨 *New Auction Setup*\n\nWhat is the item name?\n\n_/cancel at any time._',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 1: name → ask description
  async (ctx) => {
    if (!ctx.message?.text) return;
    const name = ctx.message.text.trim();
    if (name.length < 2) return ctx.reply('Name too short. Try again:');
    ctx.wizard.state.name = name;
    await ctx.reply('Description? (optional — send `-` to skip)', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  // Step 2: description → ask starting bid
  async (ctx) => {
    if (!ctx.message?.text) return;
    const desc = ctx.message.text.trim();
    ctx.wizard.state.description = desc === '-' ? null : desc;
    await ctx.reply('Starting bid? (e.g. `10.00`)', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  // Step 3: starting bid → ask min increment
  async (ctx) => {
    if (!ctx.message?.text) return;
    const bid = parseFloat(ctx.message.text.trim());
    if (isNaN(bid) || bid <= 0) return ctx.reply('❌ Enter a positive number:');
    ctx.wizard.state.startingBid = bid;
    await ctx.reply('Minimum bid increment? (e.g. `5.00`)', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  // Step 4: min increment → ask end time
  async (ctx) => {
    if (!ctx.message?.text) return;
    const inc = parseFloat(ctx.message.text.trim());
    if (isNaN(inc) || inc <= 0) return ctx.reply('❌ Enter a positive number:');
    ctx.wizard.state.minIncrement = inc;
    await ctx.reply(
      'Auction end time (SGT)?\n\nFormat: `DD/MM/YYYY HH:MM`\nExample: `15/05/2026 20:00`',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 5: end time → confirm
  async (ctx) => {
    if (!ctx.message?.text) return;
    const endTime = parseSGTDateTime(ctx.message.text.trim());
    if (!endTime || endTime <= new Date()) {
      return ctx.reply('❌ Invalid or past date. Format: `DD/MM/YYYY HH:MM`', { parse_mode: 'Markdown' });
    }
    ctx.wizard.state.endTime = endTime;

    const { name, description, startingBid, minIncrement } = ctx.wizard.state;
    const endStr = endTime.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });

    await ctx.reply(
      `*Confirm new auction:*\n\n` +
      `Name: *${name}*\n` +
      `Description: ${description || '_none_'}\n` +
      `Starting bid: *$${startingBid.toFixed(2)}*\n` +
      `Min increment: *$${minIncrement.toFixed(2)}*\n` +
      `Ends: *${endStr} SGT*\n\n` +
      `Reply *yes* to create or *no* to cancel.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 6: create auction
  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled. No auction was created.');
      return ctx.scene.leave();
    }

    const { messageId, name, description, startingBid, minIncrement, endTime } = ctx.wizard.state;

    const existing = await AuctionModel.findByMessageId(messageId);
    if (existing) {
      await ctx.reply(
        `⚠️ Post #${messageId} already has an auction: *${existing.name}*.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }

    const auction = await AuctionModel.create({
      telegramMessageId: messageId,
      name,
      description,
      startingBid,
      minIncrement,
      endTime,
      createdBy: ctx.from.id,
    });

    const endStr = new Date(auction.end_time).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    await ctx.reply(
      `✅ *Auction created!*\n\n` +
      `*${auction.name}*\n` +
      `Starting bid: $${parseFloat(auction.starting_bid).toFixed(2)}\n` +
      `Min increment: $${parseFloat(auction.min_increment).toFixed(2)}\n` +
      `Ends: ${endStr} SGT\n` +
      `Post ID: ${auction.telegram_message_id}`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

newAuctionWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.');
  return ctx.scene.leave();
});

newAuctionWizard.hears(/^\/\w+/, (ctx) =>
  ctx.reply('⚠️ Use /cancel to exit the auction wizard first.')
);
