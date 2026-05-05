// src/modules/scheduler/scheduleWizard.js
import { Scenes, Markup } from 'telegraf';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { schedulePost } from './schedulerService.js';

export const SCHEDULE_WIZARD_ID = 'schedule-post-wizard';

let _bot = null;
export function initScheduleWizard(bot) { _bot = bot; }

// Step indices for selectStep() jumps
const STEP_SCHEDULE = 7; // all types arrive here for "when to post"
const STEP_CONFIRM  = 8; // preview confirm + create

// Step flow per type:
//   free_form:        0→1→2(content)→selectStep(7)→7→8
//   product_listing:  0→1→2(name)→3(price)→4(qty)→5(desc)→selectStep(7)→7→8
//   auction_listing:  0→1→2(name)→3(desc)→4(startBid)→5(minInc)→6(endTime)→selectStep(7)→7→8

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

function buildPreview(state) {
  if (state.type === 'free_form') {
    const snippet = state.content.length > 120
      ? state.content.slice(0, 120) + '…'
      : state.content;
    return `_${snippet}_`;
  }
  if (state.type === 'product_listing') {
    return (
      `📦 *${state.name}*\n` +
      (state.description ? `${state.description}\n` : '') +
      `$${state.price.toFixed(2)} · ${state.quantity} unit(s)\n\n` +
      `Comment \`claim\` to reserve.`
    );
  }
  if (state.type === 'auction_listing') {
    const endStr = state.auctionEndTime.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return (
      `🔨 *Auction: ${state.name}*\n` +
      (state.description ? `${state.description}\n` : '') +
      `Starting bid: $${state.startingBid.toFixed(2)}\n` +
      `Min increment: $${state.minIncrement.toFixed(2)}\n` +
      `Ends: ${endStr} SGT\n\n` +
      `Comment \`bid [amount]\` to bid.`
    );
  }
  return '';
}

export const scheduleWizard = new Scenes.WizardScene(
  SCHEDULE_WIZARD_ID,

  // ── Step 0: ask type (or handle prefill from /editscheduled) ──────────────
  async (ctx) => {
    const prefill = ctx.scene.state?.prefill;
    if (prefill) {
      Object.assign(ctx.wizard.state, prefill);
      const preview = buildPreview(ctx.wizard.state);
      const typeLabel = {
        free_form: 'Free-form',
        product_listing: 'Product listing',
        auction_listing: 'Auction listing',
      }[prefill.type] || prefill.type;

      await ctx.reply(
        `✏️ *Editing scheduled post*\n\nType: ${typeLabel}\n\n${preview}\n\n` +
        `Enter a new posting time (SGT, \`DD/MM/YYYY HH:MM\`) to reschedule, or /cancel to abort.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.wizard.selectStep(STEP_SCHEDULE);
    }

    await ctx.reply(
      '📅 *Schedule a Channel Post*\n\nWhat type of post?',
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          ['📝 Free-form text', '📦 Product listing'],
          ['🔨 Auction listing', '/cancel'],
        ]).resize().oneTime(),
      }
    );
    return ctx.wizard.next();
  },

  // ── Step 1: record type, ask first field ──────────────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const t = ctx.message.text;

    if (t.includes('Free-form'))    ctx.wizard.state.type = 'free_form';
    else if (t.includes('Product')) ctx.wizard.state.type = 'product_listing';
    else if (t.includes('Auction')) ctx.wizard.state.type = 'auction_listing';
    else return ctx.reply('Please select one of the options from the keyboard.');

    if (ctx.wizard.state.type === 'free_form') {
      await ctx.reply('Type your post content:', Markup.removeKeyboard());
    } else {
      await ctx.reply('Item name:', Markup.removeKeyboard());
    }
    return ctx.wizard.next();
  },

  // ── Step 2: content (free_form) / name (product+auction) ─────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const type = ctx.wizard.state.type;

    if (type === 'free_form') {
      ctx.wizard.state.content = ctx.message.text.trim();
      await ctx.reply(
        'When to post? (SGT)\n\nFormat: `DD/MM/YYYY HH:MM`\nExample: `20/05/2026 18:00`',
        { parse_mode: 'Markdown' }
      );
      return ctx.wizard.selectStep(STEP_SCHEDULE);
    }

    const name = ctx.message.text.trim();
    if (name.length < 2) return ctx.reply('Name too short. Try again:');
    ctx.wizard.state.name = name;

    if (type === 'product_listing') {
      await ctx.reply('Price per unit? (e.g. `12.50`)', { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('Description? (optional — send `-` to skip)', { parse_mode: 'Markdown' });
    }
    return ctx.wizard.next();
  },

  // ── Step 3: price (product) / description (auction) ──────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const type = ctx.wizard.state.type;

    if (type === 'product_listing') {
      const p = parseFloat(ctx.message.text.trim());
      if (isNaN(p) || p <= 0) return ctx.reply('❌ Invalid price. Enter a positive number (e.g. `12.50`):', { parse_mode: 'Markdown' });
      ctx.wizard.state.price = p;
      await ctx.reply('How many units available?');
    } else {
      ctx.wizard.state.description = ctx.message.text.trim() === '-' ? null : ctx.message.text.trim();
      await ctx.reply('Starting bid? (e.g. `10.00`)', { parse_mode: 'Markdown' });
    }
    return ctx.wizard.next();
  },

  // ── Step 4: quantity (product) / starting_bid (auction) ──────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const type = ctx.wizard.state.type;

    if (type === 'product_listing') {
      const q = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(q) || q <= 0) return ctx.reply('❌ Enter a whole number greater than 0:');
      ctx.wizard.state.quantity = q;
      await ctx.reply('Item description? (optional — send `-` to skip)', { parse_mode: 'Markdown' });
    } else {
      const b = parseFloat(ctx.message.text.trim());
      if (isNaN(b) || b <= 0) return ctx.reply('❌ Enter a positive number:');
      ctx.wizard.state.startingBid = b;
      await ctx.reply('Minimum bid increment? (e.g. `5.00`)', { parse_mode: 'Markdown' });
    }
    return ctx.wizard.next();
  },

  // ── Step 5: description (product → then jump) / min_increment (auction) ──
  async (ctx) => {
    if (!ctx.message?.text) return;
    const type = ctx.wizard.state.type;

    if (type === 'product_listing') {
      ctx.wizard.state.description = ctx.message.text.trim() === '-' ? null : ctx.message.text.trim();
      await ctx.reply(
        'When to post? (SGT)\n\nFormat: `DD/MM/YYYY HH:MM`\nExample: `20/05/2026 18:00`',
        { parse_mode: 'Markdown' }
      );
      return ctx.wizard.selectStep(STEP_SCHEDULE);
    }

    const inc = parseFloat(ctx.message.text.trim());
    if (isNaN(inc) || inc <= 0) return ctx.reply('❌ Enter a positive number:');
    ctx.wizard.state.minIncrement = inc;
    await ctx.reply(
      'Auction end time? (SGT)\n\nFormat: `DD/MM/YYYY HH:MM`\nExample: `30/05/2026 21:00`',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // ── Step 6: end_time (auction only) → then jump to schedule time ─────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const endTime = parseSGTDateTime(ctx.message.text.trim());
    if (!endTime || endTime <= new Date()) {
      return ctx.reply('❌ Invalid or past date. Format: `DD/MM/YYYY HH:MM`', { parse_mode: 'Markdown' });
    }
    ctx.wizard.state.auctionEndTime = endTime;
    await ctx.reply(
      'When to post to the channel? (SGT)\n\nFormat: `DD/MM/YYYY HH:MM`\nExample: `20/05/2026 18:00`',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.selectStep(STEP_SCHEDULE);
  },

  // ── Step 7 (STEP_SCHEDULE): schedule time — all types arrive here ─────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const when = parseSGTDateTime(ctx.message.text.trim());
    if (!when || when <= new Date()) {
      return ctx.reply('❌ Invalid or past date. Format: `DD/MM/YYYY HH:MM`', { parse_mode: 'Markdown' });
    }
    ctx.wizard.state.scheduledAt = when;

    const whenStr = when.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    const preview = buildPreview(ctx.wizard.state);

    await ctx.reply(
      `*Post preview:*\n\n${preview}\n\n*Posts at:* ${whenStr} SGT\n\nReply *yes* to schedule or *no* to cancel.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // ── Step 8 (STEP_CONFIRM): confirm + create ───────────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled. No post was scheduled.', Markup.removeKeyboard());
      return ctx.scene.leave();
    }

    const {
      type, content, name, price, quantity, description,
      startingBid, minIncrement, auctionEndTime, scheduledAt,
    } = ctx.wizard.state;

    const post = await ScheduledPostModel.create({
      type,
      content:             type === 'free_form'       ? content     : null,
      productName:         type === 'product_listing' ? name        : null,
      productPrice:        type === 'product_listing' ? price       : null,
      productQuantity:     type === 'product_listing' ? quantity    : null,
      productDescription:  type === 'product_listing' ? description : null,
      auctionName:         type === 'auction_listing' ? name        : null,
      auctionDescription:  type === 'auction_listing' ? description : null,
      auctionStartingBid:  type === 'auction_listing' ? startingBid    : null,
      auctionMinIncrement: type === 'auction_listing' ? minIncrement   : null,
      auctionEndTime:      type === 'auction_listing' ? auctionEndTime : null,
      scheduledAt,
      createdBy: ctx.from.id,
    });

    if (_bot) schedulePost(_bot, post);

    const whenStr = scheduledAt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    await ctx.reply(
      `✅ *Post #${post.id} scheduled!*\n\nPosts at: ${whenStr} SGT\n\nView: /listscheduled · Cancel: \`/deletescheduled ${post.id}\``,
      { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
    );
    return ctx.scene.leave();
  }
);

scheduleWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.', Markup.removeKeyboard());
  return ctx.scene.leave();
});

// Any other command: silently leave the wizard so the global handler can process it
scheduleWizard.hears(/^\/\w+/, async (ctx, next) => {
  await ctx.scene.leave();
  return next();
});
