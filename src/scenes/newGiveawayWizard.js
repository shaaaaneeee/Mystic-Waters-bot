// src/scenes/newGiveawayWizard.js
import { Scenes, Markup } from 'telegraf';
import { GiveawayModel } from '../models/giveaway.js';

export const NEW_GIVEAWAY_WIZARD_ID = 'new-giveaway-wizard';

let _bot = null;
export function initGiveawayWizard(bot) { _bot = bot; }

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

  // Step 3: notes → ask for image
  async (ctx) => {
    if (!ctx.message?.text) return;
    const notes = ctx.message.text.trim();
    ctx.wizard.state.notes = notes === '-' ? null : notes;

    await ctx.reply(
      '📸 Send a giveaway image, or tap Skip to post without one.',
      Markup.inlineKeyboard([[Markup.button.callback('Skip (no image)', 'skip_giveaway_image')]])
    );
    return ctx.wizard.next();
  },

  // Step 4: image/skip → confirm
  async (ctx) => {
    if (ctx.message?.photo) {
      const photos = ctx.message.photo;
      ctx.wizard.state.imageFileId = photos[photos.length - 1].file_id;
      await ctx.answerCbQuery?.();
    } else if (ctx.callbackQuery?.data === 'skip_giveaway_image') {
      ctx.wizard.state.imageFileId = null;
      await ctx.answerCbQuery('No image — skipping.');
    } else {
      await ctx.reply('Please send a photo or tap Skip.');
      return;
    }

    const { title, prizeDescription, imageFileId } = ctx.wizard.state;
    const previewText =
      `*Confirm giveaway:*\n\n` +
      `Title: *${title}*\n` +
      `Prize: ${prizeDescription || '_none_'}\n\n` +
      `Reply *yes* to start.`;

    if (imageFileId) {
      await ctx.replyWithPhoto(imageFileId, {
        caption: previewText,
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply(previewText, { parse_mode: 'Markdown' });
    }
    return ctx.wizard.next();
  },

  // Step 5: create pool + announce to channel
  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled.');
      return ctx.scene.leave();
    }

    const { title, prizeDescription, notes, imageFileId } = ctx.wizard.state;
    const pool = await GiveawayModel.createPool({
      title, prizeDescription, notes, createdBy: ctx.from.id, imageFileId,
    });

    // Announce to channel
    if (_bot && process.env.CHANNEL_ID) {
      const announcement =
        `🎁 *Giveaway: ${pool.title}*\n\n` +
        (prizeDescription ? `Prize: ${prizeDescription}\n\n` : '') +
        (notes ? `${notes}\n\n` : '') +
        `Purchase from the shop to earn entries automatically!`;

      try {
        if (imageFileId) {
          await _bot.telegram.sendPhoto(process.env.CHANNEL_ID, imageFileId, {
            caption: announcement,
            parse_mode: 'Markdown',
          });
        } else {
          await _bot.telegram.sendMessage(process.env.CHANNEL_ID, announcement, {
            parse_mode: 'Markdown',
          });
        }
      } catch (err) {
        console.error('[Giveaway] Failed to post channel announcement:', err.message);
      }
    }

    await ctx.reply(
      `✅ Giveaway *${pool.title}* is now active!\n\nEntries are added automatically when invoices are confirmed as paid.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

newGiveawayWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.');
  return ctx.scene.leave();
});
