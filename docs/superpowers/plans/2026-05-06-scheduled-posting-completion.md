# Scheduled Posting System — Gap Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the scheduled posting system so product and auction listings collect full details in the wizard, auto-create inventory records when sent, and support editing via `/editscheduled`.

**Architecture:** Features 1–7 are fully implemented and working. This plan covers only the 3 genuine gaps in Feature 8 (Scheduled Channel Posting): (1) the schedule wizard incorrectly asks for an existing channel post ID instead of collecting product/auction details; (2) `firePost` doesn't capture the sent message's ID or register the post in `post_registry`/`products`/`auctions`; (3) `/editscheduled` is missing entirely. The fix is a DB migration adding inline metadata columns, a reworked 9-step wizard with `selectStep` branching, an updated `firePost` that auto-creates records, and the `/editscheduled` handler.

**Tech Stack:** Node.js 20 ESM, Telegraf 4.16.3 (`ctx.wizard.selectStep`), PostgreSQL/Supabase, node-cron, ioredis

---

## File Map

**Create:**
- `migrations/003_scheduled_posts_metadata.sql` — drop product_id/auction_id FK columns; add inline product/auction metadata columns + channel_message_id

**Modify:**
- `src/models/scheduledPost.js` — update `create()` and `listPending()` for new schema
- `src/modules/scheduler/schedulerService.js` — update `buildPostContent()` and `firePost()` to auto-create product/auction records + post_registry entry
- `src/modules/scheduler/scheduleWizard.js` — full 9-step wizard collecting product/auction details with `ctx.wizard.selectStep` branching; support pre-fill from `/editscheduled`
- `src/handlers/adminHandler.js` — add `handleEditScheduled`, update `handleHelp` to include `/editscheduled`
- `src/index.js` — register `bot.command('editscheduled', adminOnly, handleEditScheduled)`

---

## Task 1: DB Migration 003

**Files:**
- Create: `migrations/003_scheduled_posts_metadata.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/003_scheduled_posts_metadata.sql
-- Mystic Waters Bot — Scheduled Posts Metadata
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS throughout

-- Drop the old FK columns that assumed posts/auctions existed beforehand.
-- These columns stored the wrong kind of ID (telegram message IDs were passed
-- as products.id FK values, which is a different number space).
ALTER TABLE scheduled_posts DROP COLUMN IF EXISTS product_id;
ALTER TABLE scheduled_posts DROP COLUMN IF EXISTS auction_id;

-- Add inline product metadata (used when type = 'product_listing')
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS product_name        TEXT,
  ADD COLUMN IF NOT EXISTS product_price       NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS product_quantity    INTEGER,
  ADD COLUMN IF NOT EXISTS product_description TEXT;

-- Add inline auction metadata (used when type = 'auction_listing')
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS auction_name         TEXT,
  ADD COLUMN IF NOT EXISTS auction_description  TEXT,
  ADD COLUMN IF NOT EXISTS auction_starting_bid NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS auction_min_increment NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS auction_end_time     TIMESTAMPTZ;

-- channel_message_id is populated after the post is sent;
-- allows downstream systems to reference the sent post
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_channel
  ON scheduled_posts (channel_message_id)
  WHERE channel_message_id IS NOT NULL;
```

- [ ] **Step 2: Run migration against Supabase**

In Supabase dashboard → SQL Editor, paste the file content and run.

Or via CLI if configured:
```
psql $DATABASE_URL < migrations/003_scheduled_posts_metadata.sql
```

Expected: no errors. All `IF NOT EXISTS` / `IF EXISTS` guards make it safe to re-run.

- [ ] **Step 3: Commit**

```
git add migrations/003_scheduled_posts_metadata.sql
git commit -m "feat: add inline product/auction metadata columns to scheduled_posts"
```

---

## Task 2: Update ScheduledPostModel

**Files:**
- Modify: `src/models/scheduledPost.js`

- [ ] **Step 1: Replace the file**

```js
// src/models/scheduledPost.js
import { query } from '../../config/database.js';

export const ScheduledPostModel = {

  async create({
    type, content,
    productName, productPrice, productQuantity, productDescription,
    auctionName, auctionDescription, auctionStartingBid, auctionMinIncrement, auctionEndTime,
    scheduledAt, createdBy,
  }) {
    const { rows } = await query(
      `INSERT INTO scheduled_posts
         (type, content,
          product_name, product_price, product_quantity, product_description,
          auction_name, auction_description, auction_starting_bid, auction_min_increment, auction_end_time,
          scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        type, content || null,
        productName || null, productPrice || null, productQuantity || null, productDescription || null,
        auctionName || null, auctionDescription || null, auctionStartingBid || null,
        auctionMinIncrement || null, auctionEndTime || null,
        scheduledAt, createdBy,
      ]
    );
    return rows[0];
  },

  async listPending() {
    const { rows } = await query(
      `SELECT * FROM scheduled_posts WHERE status = 'pending' ORDER BY scheduled_at ASC`
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT * FROM scheduled_posts WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async markSent(id, channelMessageId) {
    await query(
      `UPDATE scheduled_posts
       SET status = 'sent', sent_at = NOW(), channel_message_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, channelMessageId || null]
    );
  },

  async markFailed(id, reason) {
    await query(
      `UPDATE scheduled_posts
       SET status = 'failed', fail_reason = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, reason]
    );
  },

  async cancel(id, reason) {
    const { rows } = await query(
      `UPDATE scheduled_posts
       SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, reason || null]
    );
    return rows[0] || null;
  },
};
```

- [ ] **Step 2: Syntax check**

```
node --check src/models/scheduledPost.js
```

Expected: no output (passes).

- [ ] **Step 3: Commit**

```
git add src/models/scheduledPost.js
git commit -m "feat: update ScheduledPostModel for inline product/auction metadata schema"
```

---

## Task 3: Update schedulerService — firePost auto-registration

**Files:**
- Modify: `src/modules/scheduler/schedulerService.js`

- [ ] **Step 1: Replace the file**

```js
// src/modules/scheduler/schedulerService.js
import cron from 'node-cron';
import { query } from '../../../config/database.js';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { ProductModel } from '../../models/product.js';
import { AuctionModel } from '../../models/auction.js';

const RATE_DELAY_MS = 150;

function buildPostContent(post) {
  if (post.type === 'free_form') return post.content || '';

  if (post.type === 'product_listing') {
    const priceStr = `$${parseFloat(post.product_price).toFixed(2)}`;
    return [
      `📦 *${post.product_name}*`,
      '',
      post.product_description || '',
      post.product_description ? '' : null,
      `${priceStr} · ${post.product_quantity} unit(s)`,
      '',
      'Comment `claim` below to reserve yours!',
    ].filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (post.type === 'auction_listing') {
    const endStr = new Date(post.auction_end_time).toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    return [
      `🔨 *Auction: ${post.auction_name}*`,
      '',
      post.auction_description || null,
      post.auction_description ? '' : null,
      `Starting bid: $${parseFloat(post.auction_starting_bid).toFixed(2)}`,
      `Min increment: $${parseFloat(post.auction_min_increment).toFixed(2)}`,
      `Ends: ${endStr} SGT`,
      '',
      'Comment `bid [amount]` to place a bid!',
    ].filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return '';
}

const activeTimeouts = new Map();

export function schedulePost(bot, post) {
  const msUntilPost = new Date(post.scheduled_at) - Date.now();
  if (msUntilPost <= 0) {
    firePost(bot, post);
    return;
  }
  const handle = setTimeout(() => firePost(bot, post), msUntilPost);
  activeTimeouts.set(post.id, handle);
}

export function cancelScheduledPost(postId) {
  const handle = activeTimeouts.get(postId);
  if (handle) {
    clearTimeout(handle);
    activeTimeouts.delete(postId);
  }
}

async function firePost(bot, post) {
  activeTimeouts.delete(post.id);
  const content = buildPostContent(post);

  let sentMsgId = null;
  try {
    const sentMsg = await bot.telegram.sendMessage(
      process.env.CHANNEL_ID, content, { parse_mode: 'Markdown' }
    );
    sentMsgId = sentMsg.message_id;
    console.log(`[Scheduler] Sent post #${post.id} (${post.type}) → channel msg ${sentMsgId}`);
  } catch (err) {
    console.error(`[Scheduler] Failed post #${post.id}:`, err.message);
    await ScheduledPostModel.markFailed(post.id, err.message);
    return;
  }

  await ScheduledPostModel.markSent(post.id, sentMsgId);

  // Auto-register the channel post in inventory systems
  if (post.type === 'product_listing') {
    try {
      const product = await ProductModel.create({
        telegramMessageId: sentMsgId,
        name: post.product_name,
        price: post.product_price,
        quantity: post.product_quantity,
      });
      await query(
        `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
         VALUES ($1, 'product', $2) ON CONFLICT DO NOTHING`,
        [sentMsgId, product.id]
      );
      console.log(`[Scheduler] Registered product #${product.id} for post ${sentMsgId}`);
    } catch (err) {
      console.error(`[Scheduler] product registration failed for post #${post.id}:`, err.message);
    }
  } else if (post.type === 'auction_listing') {
    try {
      // AuctionModel.create also inserts into post_registry atomically
      const auction = await AuctionModel.create({
        telegramMessageId: sentMsgId,
        name: post.auction_name,
        description: post.auction_description,
        startingBid: post.auction_starting_bid,
        minIncrement: post.auction_min_increment,
        endTime: post.auction_end_time,
        createdBy: post.created_by,
      });
      console.log(`[Scheduler] Registered auction #${auction.id} for post ${sentMsgId}`);
    } catch (err) {
      console.error(`[Scheduler] auction registration failed for post #${post.id}:`, err.message);
    }
  }
}

export async function init(bot) {
  const pending = await ScheduledPostModel.listPending();
  console.log(`[Scheduler] Rehydrating ${pending.length} pending post(s)`);

  for (const post of pending) {
    schedulePost(bot, post);
    await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }

  const adminId = parseInt((process.env.ADMIN_IDS || '').split(',')[0], 10);

  cron.schedule('* * * * *', async () => {
    try {
      const { runAuctionLifecycle } = await import('../auction/auctionService.js');
      await runAuctionLifecycle(bot.telegram, adminId);
    } catch (err) {
      console.error('[Cron] Auction lifecycle error:', err.message);
    }
  });

  console.log('[Scheduler] Cron started');
}
```

- [ ] **Step 2: Syntax check**

```
node --check src/modules/scheduler/schedulerService.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```
git add src/modules/scheduler/schedulerService.js
git commit -m "feat: firePost captures message_id and auto-registers product/auction in post_registry"
```

---

## Task 4: Rework scheduleWizard — full detail collection with selectStep branching

**Files:**
- Modify: `src/modules/scheduler/scheduleWizard.js`

The wizard has 9 steps (indices 0–8). Different post types take different paths through the middle steps using `ctx.wizard.selectStep(N)` to jump. The 9 step indices are:

```
0  Ask type
1  First field: name (product/auction) or content (free_form)
2  Second field: price (product) / description (auction) [free_form jumps here to schedule time via selectStep(7)]
3  Third field: quantity (product) / starting_bid (auction)
4  Fourth field: description (product) / min_increment (auction)   [product jumps to schedule time via selectStep(7) after this]
5  Fifth field: end_time (auction only)                            [auction continues to step 6]
6  Sixth field: (auction only) → selectStep(7) after end_time
   Wait — auction end_time is step 5, then jumps to step 7.
   Product: steps 1→2→3→4 then selectStep(7)
   Free_form: step 1 then selectStep(7)
   Auction: steps 1→2→3→4→5 then selectStep(7)
   
   So steps 0,1 = type + first field
   Steps 2,3,4 = shared slots (product uses all 3; auction uses all 3 for different things)
   Step 5 = auction-only (end_time)
   Step 6 = unused slot (padding so selectStep(7) is valid for auction after step 5)
             Actually, step 5 for auction does end_time then selectStep(7). Fine.
   Step 7 = schedule time (all types land here)
   Step 8 = confirm + create
```

Revised step layout:
- Step 0: ask type
- Step 1: process type, ask first field
- Step 2: name/content → product asks price; auction asks description; free_form: store content, `selectStep(7)`
- Step 3: price/description → product asks quantity; auction asks starting_bid
- Step 4: quantity/starting_bid → product asks description, then `selectStep(7)`; auction asks min_increment
- Step 5: min_increment (auction) → ask end_time; `selectStep(7)` after [product/free_form never reach step 5]
- Step 6: (padding — never executed; allows step 5 auction to selectStep(7))
- Step 7: schedule time (all types arrive here) → show preview
- Step 8: confirm → create post

- [ ] **Step 1: Replace the file**

```js
// src/modules/scheduler/scheduleWizard.js
import { Scenes, Markup } from 'telegraf';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { schedulePost } from './schedulerService.js';

export const SCHEDULE_WIZARD_ID = 'schedule-post-wizard';

let _bot = null;
export function initScheduleWizard(bot) { _bot = bot; }

const STEP_SCHEDULE = 7;

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
    else return ctx.reply('Please select from the keyboard.');

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

  // ── Step 6: end_time (auction only; jumps to schedule time after) ─────────
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

    const whenStr  = when.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    const preview  = buildPreview(ctx.wizard.state);

    await ctx.reply(
      `*Post preview:*\n\n${preview}\n\n*Posts at:* ${whenStr} SGT\n\nReply *yes* to schedule or *no* to cancel.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // ── Step 8: confirm + create ──────────────────────────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled. No post was scheduled.');
      return ctx.scene.leave();
    }

    const {
      type, content, name, price, quantity, description,
      startingBid, minIncrement, auctionEndTime, scheduledAt,
    } = ctx.wizard.state;

    const post = await ScheduledPostModel.create({
      type,
      content:               type === 'free_form'       ? content     : null,
      productName:           type === 'product_listing' ? name        : null,
      productPrice:          type === 'product_listing' ? price       : null,
      productQuantity:       type === 'product_listing' ? quantity    : null,
      productDescription:    type === 'product_listing' ? description : null,
      auctionName:           type === 'auction_listing' ? name        : null,
      auctionDescription:    type === 'auction_listing' ? description : null,
      auctionStartingBid:    type === 'auction_listing' ? startingBid    : null,
      auctionMinIncrement:   type === 'auction_listing' ? minIncrement   : null,
      auctionEndTime:        type === 'auction_listing' ? auctionEndTime : null,
      scheduledAt,
      createdBy: ctx.from.id,
    });

    if (_bot) schedulePost(_bot, post);

    const whenStr = scheduledAt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    await ctx.reply(
      `✅ *Post #${post.id} scheduled!*\n\nPosts at: ${whenStr} SGT\n\nView with /listscheduled · Cancel with \`/deletescheduled ${post.id}\``,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

scheduleWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.', Markup.removeKeyboard());
  return ctx.scene.leave();
});

scheduleWizard.hears(/^\/\w+/, (ctx) =>
  ctx.reply('⚠️ Use /cancel to exit the schedule wizard first.')
);
```

- [ ] **Step 2: Syntax check**

```
node --check src/modules/scheduler/scheduleWizard.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```
git add src/modules/scheduler/scheduleWizard.js
git commit -m "feat: rework scheduleWizard to collect full product/auction details with selectStep branching"
```

---

## Task 5: Add handleEditScheduled + update handleHelp

**Files:**
- Modify: `src/handlers/adminHandler.js`

- [ ] **Step 1: Add `handleEditScheduled` after `handleDeleteScheduled`**

Find this block in adminHandler.js (around line 540–551):

```js
export async function handleDeleteScheduled(ctx) {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/deletescheduled <id>`', { parse_mode: 'Markdown' });

  const { cancelScheduledPost } = await import('../modules/scheduler/schedulerService.js');
  cancelScheduledPost(id);

  const cancelled = await ScheduledPostModel.cancel(id, 'Cancelled by admin');
  if (!cancelled) return ctx.reply(`❌ Post #${id} not found or already sent/cancelled.`);

  return ctx.reply(`✅ Scheduled post #${id} cancelled.`);
}
```

Add this function immediately after it:

```js
export async function handleEditScheduled(ctx) {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/editscheduled <id>`', { parse_mode: 'Markdown' });

  const post = await ScheduledPostModel.findById(id);
  if (!post) return ctx.reply(`❌ Scheduled post #${id} not found.`);
  if (post.status !== 'pending') {
    return ctx.reply(`❌ Post #${id} is *${post.status}* — only pending posts can be edited.`, { parse_mode: 'Markdown' });
  }

  // Cancel the existing post (in-memory timeout + DB)
  const { cancelScheduledPost } = await import('../modules/scheduler/schedulerService.js');
  cancelScheduledPost(id);
  await ScheduledPostModel.cancel(id, 'Superseded by edit');

  // Build prefill state from existing post
  const prefill = {
    type: post.type,
    content:      post.content,
    name:         post.product_name || post.auction_name,
    price:        post.product_price ? parseFloat(post.product_price) : undefined,
    quantity:     post.product_quantity,
    description:  post.product_description || post.auction_description,
    startingBid:  post.auction_starting_bid ? parseFloat(post.auction_starting_bid) : undefined,
    minIncrement: post.auction_min_increment ? parseFloat(post.auction_min_increment) : undefined,
    auctionEndTime: post.auction_end_time ? new Date(post.auction_end_time) : undefined,
  };

  await ctx.reply(`✏️ Editing post #${id}. Old post cancelled — opening wizard with existing details.`);
  return ctx.scene.enter('schedule-post-wizard', { prefill });
}
```

- [ ] **Step 2: Update `handleHelp` — add `/editscheduled` to scheduling section**

Find this exact block in handleHelp:

```js
    `*📅 Scheduling*\n` +
    `/schedulepost — schedule a channel post\n` +
    `/listscheduled — pending posts\n` +
    `/deletescheduled <id> — cancel scheduled post\n\n` +
```

Replace with:

```js
    `*📅 Scheduling*\n` +
    `/schedulepost — schedule a channel post\n` +
    `/listscheduled — pending posts\n` +
    `/editscheduled <id> — reschedule a pending post\n` +
    `/deletescheduled <id> — cancel scheduled post\n\n` +
```

- [ ] **Step 3: Syntax check**

```
node --check src/handlers/adminHandler.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```
git add src/handlers/adminHandler.js
git commit -m "feat: add /editscheduled handler and update /help"
```

---

## Task 6: Register /editscheduled in index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add the import for handleEditScheduled**

Find this line in index.js:

```js
  handleListScheduled, handleDeleteScheduled,
} from './handlers/adminHandler.js';
```

Replace with:

```js
  handleListScheduled, handleDeleteScheduled, handleEditScheduled,
} from './handlers/adminHandler.js';
```

- [ ] **Step 2: Register the command**

Find this block:

```js
bot.command('listscheduled',   adminOnly, handleListScheduled);
bot.command('deletescheduled', adminOnly, handleDeleteScheduled);
```

Replace with:

```js
bot.command('listscheduled',   adminOnly, handleListScheduled);
bot.command('editscheduled',   adminOnly, handleEditScheduled);
bot.command('deletescheduled', adminOnly, handleDeleteScheduled);
```

- [ ] **Step 3: Syntax check**

```
node --check src/index.js
```

Expected: no output.

- [ ] **Step 4: Commit + push**

```
git add src/index.js
git commit -m "feat: register /editscheduled command"
git push
```

---

## Self-Review

### 1. Spec Coverage

| Spec requirement | Covered by |
|---|---|
| Wizard asks name, price, qty, description | Task 4 — steps 2–5 (product path) |
| Wizard asks name, desc, starting bid, increment, end time | Task 4 — steps 2–6 (auction path) |
| Bot posts to channel at scheduled time | Task 3 — firePost |
| Auto-register product in post_registry when post goes live | Task 3 — firePost product_listing branch |
| Auto-register auction in post_registry when post goes live | Task 3 — firePost auction_listing branch |
| /editscheduled | Task 5 + 6 |
| /listscheduled | Already implemented; handleListScheduled reads product_name/auction_name directly from row after migration |
| /deletescheduled | Already implemented; unchanged |
| /schedulepost | Task 4 — replaces broken wizard |
| Persist after restart | ScheduledPostModel.listPending() + init() rehydration — unchanged |
| SGT display, UTC storage | parseSGTDateTime stores as UTC; toLocaleString with Asia/Singapore for display |
| Prevent duplicate posting | DB status='pending' checked before send; markSent called immediately after |
| /help updated | Task 5 step 2 |

### 2. Placeholder Scan

None. All steps contain complete code.

### 3. Type Consistency

- `ScheduledPostModel.create()` uses `productName`, `productPrice`, etc. (camelCase JS params) → stored as `product_name`, `product_price` (snake_case DB columns). ✅
- `firePost` reads `post.product_name`, `post.product_price` etc. (snake_case from DB row). ✅
- `buildPreview` reads `state.name`, `state.price`, `state.quantity` (wizard state). ✅
- `handleEditScheduled` maps DB row (`post.product_name`) → prefill state (`name: post.product_name`). ✅
- Wizard step 8 reads `ctx.wizard.state.name`, `price`, `quantity` etc. ✅

### 4. Breaking Change Check

`handleListScheduled` in adminHandler.js currently reads `p.product_name` and `p.auction_name` from the query result. After migration 003, these come directly from the `scheduled_posts` table columns instead of a JOIN alias — the column name is the same (`product_name`, `auction_name`), so the handler continues to work without modification. ✅
