// src/modules/scheduler/scheduleWizard.js
import { Scenes, Markup } from 'telegraf';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { schedulePost } from './schedulerService.js';

export const SCHEDULE_WIZARD_ID = 'schedule-post-wizard';

let _bot = null;
export function initScheduleWizard(bot) { _bot = bot; }

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

export const scheduleWizard = new Scenes.WizardScene(
  SCHEDULE_WIZARD_ID,

  // Step 0: ask post type
  async (ctx) => {
    await ctx.reply(
      '📅 *Schedule a Channel Post*\n\nWhat type of post?',
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          ['📝 Free-form text'],
          ['📦 Product listing'],
          ['🔨 Auction listing'],
          ['/cancel'],
        ]).resize().oneTime(),
      }
    );
    return ctx.wizard.next();
  },

  // Step 1: handle type selection, ask for content / ID
  async (ctx) => {
    if (!ctx.message?.text) return;
    const t = ctx.message.text;

    if (t.includes('Free-form'))   ctx.wizard.state.type = 'free_form';
    else if (t.includes('Product')) ctx.wizard.state.type = 'product_listing';
    else if (t.includes('Auction')) ctx.wizard.state.type = 'auction_listing';
    else return ctx.reply('Please select one of the options.');

    if (ctx.wizard.state.type === 'free_form') {
      await ctx.reply('Type your post content:', Markup.removeKeyboard());
    } else {
      await ctx.reply('Enter the post ID (message ID from the channel):', Markup.removeKeyboard());
    }
    return ctx.wizard.next();
  },

  // Step 2: receive content or post ID — ask schedule time
  async (ctx) => {
    if (!ctx.message?.text) return;
    const type = ctx.wizard.state.type;

    if (type === 'free_form') {
      ctx.wizard.state.content = ctx.message.text;
    } else {
      const id = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(id)) return ctx.reply('❌ Invalid ID. Enter a number:');
      ctx.wizard.state.postId = id;
    }

    await ctx.reply(
      'When should it be posted? (SGT)\n\nFormat: `DD/MM/YYYY HH:MM`\nExample: `20/05/2026 18:00`',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 3: parse time → preview → confirm
  async (ctx) => {
    if (!ctx.message?.text) return;
    const when = parseSGTDateTime(ctx.message.text.trim());
    if (!when || when <= new Date()) {
      return ctx.reply('❌ Invalid or past date. Format: `DD/MM/YYYY HH:MM`', { parse_mode: 'Markdown' });
    }
    ctx.wizard.state.scheduledAt = when;

    const labels = { free_form: 'Free-form', product_listing: 'Product listing', auction_listing: 'Auction listing' };
    const typeLabel = labels[ctx.wizard.state.type];
    const whenStr   = when.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    const preview   = ctx.wizard.state.content
      ? `\nPreview: _${ctx.wizard.state.content.slice(0, 80)}${ctx.wizard.state.content.length > 80 ? '…' : ''}_`
      : `\nPost ID: ${ctx.wizard.state.postId}`;

    await ctx.reply(
      `*Confirm scheduled post:*\nType: ${typeLabel}${preview}\nWhen: *${whenStr} SGT*\n\nReply *yes* to schedule.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 4: confirm → create
  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled.');
      return ctx.scene.leave();
    }

    const { type, content, postId, scheduledAt } = ctx.wizard.state;
    const post = await ScheduledPostModel.create({
      type,
      content:   type === 'free_form' ? content : null,
      productId: type === 'product_listing' ? postId : null,
      auctionId: type === 'auction_listing' ? postId : null,
      scheduledAt,
      createdBy: ctx.from.id,
    });

    if (_bot) schedulePost(_bot, post);

    const whenStr = scheduledAt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    await ctx.reply(
      `✅ Post #${post.id} scheduled for *${whenStr} SGT*.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

scheduleWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.');
  return ctx.scene.leave();
});
