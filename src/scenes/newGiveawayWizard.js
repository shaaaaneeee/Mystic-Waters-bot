// src/scenes/newGiveawayWizard.js
import { Scenes } from 'telegraf';
import { GiveawayModel } from '../models/giveaway.js';

export const NEW_GIVEAWAY_WIZARD_ID = 'new-giveaway-wizard';

export const newGiveawayWizard = new Scenes.WizardScene(
  NEW_GIVEAWAY_WIZARD_ID,

  // Step 0: check for existing active pool, then ask title
  async (ctx) => {
    const existing = await GiveawayModel.getActivePool();
    if (existing) {
      await ctx.reply(
        `⚠️ There's already an active pool: *${existing.title}*\n\nUse /cleargiveaway to cancel it first.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }
    await ctx.reply(
      '🎁 *New Giveaway*\n\nWhat is the giveaway title?\n\n_/cancel to stop._',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 1: title → ask prize description
  async (ctx) => {
    if (!ctx.message?.text) return;
    const title = ctx.message.text.trim();
    if (title.length < 3) return ctx.reply('Title too short. Try again:');
    ctx.wizard.state.title = title;
    await ctx.reply('Prize description? (optional — send `-` to skip)');
    return ctx.wizard.next();
  },

  // Step 2: prize → ask notes
  async (ctx) => {
    if (!ctx.message?.text) return;
    const desc = ctx.message.text.trim();
    ctx.wizard.state.prizeDescription = desc === '-' ? null : desc;
    await ctx.reply('Any notes? (optional — send `-` to skip)');
    return ctx.wizard.next();
  },

  // Step 3: notes → confirm
  async (ctx) => {
    if (!ctx.message?.text) return;
    const notes = ctx.message.text.trim();
    ctx.wizard.state.notes = notes === '-' ? null : notes;

    const { title, prizeDescription } = ctx.wizard.state;
    await ctx.reply(
      `*Confirm giveaway:*\n\nTitle: *${title}*\nPrize: ${prizeDescription || '_none_'}\n\nReply *yes* to start.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 4: create pool
  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled.');
      return ctx.scene.leave();
    }
    const { title, prizeDescription, notes } = ctx.wizard.state;
    const pool = await GiveawayModel.createPool({
      title, prizeDescription, notes, createdBy: ctx.from.id,
    });
    await ctx.reply(
      `✅ Giveaway pool *${pool.title}* is now active!\n\nEntries are added automatically when invoices are confirmed as paid.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

newGiveawayWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.');
  return ctx.scene.leave();
});
