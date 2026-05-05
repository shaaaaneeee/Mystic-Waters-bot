# Inline Action Buttons + Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every `<id>` admin command with inline keyboard buttons on paginated listing messages, and extend the forward-to-act flow to show action buttons for already-registered posts.

**Architecture:** A shared `paginator.js` utility slices item arrays and builds the inline keyboard (item buttons + Prev/Next nav). Each listing handler (`handleStock`, `handleAuctions`, `handleListScheduled`, `handlePending`) accepts an optional `page` argument so they can be called both from commands (send new message) and from `pg:` pagination callbacks (edit existing message). Action callbacks (`act:*`) are wired in the single `callback_query` block in `index.js`.

**Tech Stack:** Telegraf 4 (`Markup.inlineKeyboard`, `ctx.editMessageText`, `ctx.callbackQuery`), Node.js ES modules, PostgreSQL via existing models.

---

## File Map

| File | Change |
|---|---|
| `src/utils/paginator.js` | **Create** — `buildPageMessage()` utility |
| `src/models/auction.js` | **Modify** — add `listActive()` |
| `src/handlers/adminHandler.js` | **Modify** — add `Markup` import; refactor 6 action handlers to accept optional ID override; rewrite `handleStock`; add `handleAuctions`; rewrite `handleListScheduled`; rewrite `handlePending`; update `/help` text |
| `src/index.js` | **Modify** — import `handleAuctions`; add `/auctions` command; add `pg:` + `act:` callback blocks; update forward-to-act handler |

---

## Callback Data Reference

All values fit under Telegram's 64-byte limit.

| Callback data | Meaning |
|---|---|
| `pg:stock:{page}` | Re-render `/stock` at page N (0-based) |
| `pg:auctions:{page}` | Re-render `/auctions` at page N |
| `pg:scheduled:{page}` | Re-render `/listscheduled` at page N |
| `pg:pending:{page}` | Re-render `/pending` at page N |
| `act:claims:{telegram_message_id}` | Show claims for a product |
| `act:cancel_prod:{telegram_message_id}` | Cancel a product listing |
| `act:bids:{telegram_message_id}` | Show bids for an auction |
| `act:end_auction:{telegram_message_id}` | Force-end an active auction |
| `act:cancel_auction:{telegram_message_id}` | Cancel an auction |
| `act:del_sched:{id}` | Delete a scheduled post |
| `act:edit_sched:{id}` | Edit a scheduled post (enters wizard) |
| `act:invoice:{telegram_user_id}` | Generate invoice for a buyer |

---

## Task 1: Paginator Utility

**Files:**
- Create: `src/utils/paginator.js`

- [ ] **Step 1: Create the file**

```js
// src/utils/paginator.js
import { Markup } from 'telegraf';

export const PAGE_SIZE = 5;

/**
 * Slices items for page N and builds message text + inline keyboard.
 * Returns { text, markup } — spread markup into ctx.reply() / ctx.editMessageText() options.
 *
 * @param {object}   opts
 * @param {any[]}    opts.items             All items (full list, unsliced)
 * @param {number}   opts.page              0-based page index
 * @param {string}   opts.entityKey         Short key for pg: callbacks ('stock', 'auctions', etc.)
 * @param {string}   opts.title             Header line — Markdown, e.g. '📦 *Stock Overview*'
 * @param {string}   opts.emptyText         Text when items array is empty
 * @param {function} opts.renderItem        (item) => string — one item's display text
 * @param {function} opts.buildItemButtons  (item) => Markup.button.callback[] — action buttons for one item
 */
export function buildPageMessage({ items, page, entityKey, title, emptyText, renderItem, buildItemButtons }) {
  if (items.length === 0) {
    return { text: emptyText, markup: Markup.inlineKeyboard([]) };
  }

  const total     = items.length;
  const start     = page * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  const pageCount = Math.ceil(total / PAGE_SIZE);

  const header = `${title} _(${total} total · page ${page + 1}/${pageCount})_\n\n`;
  const body   = pageItems.map(renderItem).join('\n\n');

  const rows = pageItems.map(item => buildItemButtons(item));

  const nav = [];
  if (page > 0)                  nav.push(Markup.button.callback('⬅️ Prev', `pg:${entityKey}:${page - 1}`));
  if (start + PAGE_SIZE < total) nav.push(Markup.button.callback('➡️ Next', `pg:${entityKey}:${page + 1}`));
  if (nav.length) rows.push(nav);

  return {
    text:   header + body,
    markup: Markup.inlineKeyboard(rows),
  };
}
```

- [ ] **Step 2: Syntax-check the file**

```powershell
node --check src/utils/paginator.js
```

Expected: no output (clean).

---

## Task 2: AuctionModel.listActive

**Files:**
- Modify: `src/models/auction.js` — add method after `findById`

- [ ] **Step 1: Add `listActive` to `AuctionModel`**

In `src/models/auction.js`, add the following method after the `findById` method (after line 49):

```js
  async listActive() {
    const { rows } = await query(
      `SELECT * FROM auctions
       WHERE status IN ('upcoming', 'active')
       ORDER BY end_time ASC`
    );
    return rows;
  },
```

- [ ] **Step 2: Syntax-check**

```powershell
node --check src/models/auction.js
```

Expected: no output.

---

## Task 3: Refactor Action Handlers to Accept Optional ID Overrides

Six existing handlers read their target ID from `ctx.message.text`. They need to also accept an override so they can be called from callback buttons (where there is no `ctx.message.text`).

**Files:**
- Modify: `src/handlers/adminHandler.js`

- [ ] **Step 1: Add `Markup` import at top of adminHandler.js**

Change the first line from:
```js
import { query } from '../../config/database.js';
```
to:
```js
import { Markup } from 'telegraf';
import { query } from '../../config/database.js';
```

- [ ] **Step 2: Refactor `handleViewClaims`**

Replace the existing function:
```js
export async function handleViewClaims(ctx) {
  const args     = ctx.message.text.split(' ');
  const rawMsgId = args[1];
  if (!rawMsgId) return ctx.reply('Usage: /claims <message\\_id>', { parse_mode: 'Markdown' });
```
with:
```js
export async function handleViewClaims(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: /claims <message\\_id>', { parse_mode: 'Markdown' });
```

- [ ] **Step 3: Refactor `handleAuctionBids`**

Replace:
```js
export async function handleAuctionBids(ctx) {
  const rawMsgId = ctx.message.text.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/auctionbids <post_id>`', { parse_mode: 'Markdown' });
```
with:
```js
export async function handleAuctionBids(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/auctionbids <post_id>`', { parse_mode: 'Markdown' });
```

Also change the reply at the end to support being called from a callback (use `ctx.reply` — we always want a NEW message for bids display, not an edit):
```js
  return ctx.reply(
    `🔨 *Bids for ${auction.name}*\n` +
    `Current: $${auction.current_bid ? parseFloat(auction.current_bid).toFixed(2) : '—'}\n\n` +
    lines.join('\n'),
    { parse_mode: 'Markdown' }
  );
```
This is already `ctx.reply` so no change needed there.

- [ ] **Step 4: Refactor `handleEndAuction`**

Replace:
```js
export async function handleEndAuction(ctx) {
  const rawMsgId = ctx.message.text.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/endauction <post_id>`', { parse_mode: 'Markdown' });
```
with:
```js
export async function handleEndAuction(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/endauction <post_id>`', { parse_mode: 'Markdown' });
```

- [ ] **Step 5: Refactor `handleCancelAuction`**

Replace:
```js
export async function handleCancelAuction(ctx) {
  const rawMsgId = ctx.message.text.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/cancelauction <post_id>`', { parse_mode: 'Markdown' });
```
with:
```js
export async function handleCancelAuction(ctx, overrideMsgId = null) {
  const rawMsgId = overrideMsgId !== null ? String(overrideMsgId) : ctx.message?.text?.split(' ')[1];
  if (!rawMsgId) return ctx.reply('Usage: `/cancelauction <post_id>`', { parse_mode: 'Markdown' });
```

- [ ] **Step 6: Refactor `handleDeleteScheduled`**

Replace:
```js
export async function handleDeleteScheduled(ctx) {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/deletescheduled <id>`', { parse_mode: 'Markdown' });
```
with:
```js
export async function handleDeleteScheduled(ctx, overrideId = null) {
  const raw = overrideId !== null ? overrideId : parseInt(ctx.message?.text?.split(' ')[1], 10);
  const id = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (isNaN(id)) return ctx.reply('Usage: `/deletescheduled <id>`', { parse_mode: 'Markdown' });
```

- [ ] **Step 7: Refactor `handleEditScheduled`**

Replace:
```js
export async function handleEditScheduled(ctx) {
  const id = parseInt(ctx.message.text.split(' ')[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/editscheduled <id>`', { parse_mode: 'Markdown' });
```
with:
```js
export async function handleEditScheduled(ctx, overrideId = null) {
  const raw = overrideId !== null ? overrideId : parseInt(ctx.message?.text?.split(' ')[1], 10);
  const id = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (isNaN(id)) return ctx.reply('Usage: `/editscheduled <id>`', { parse_mode: 'Markdown' });
```

Also change the final `ctx.reply` before entering the wizard to handle callback context — when called from a button `ctx.message` won't exist, so use `ctx.reply` (which still works since the bot can always send new messages):
```js
  await ctx.reply(`✏️ Post #${id} cancelled. Opening wizard with existing details — just enter a new time.`);
  return ctx.scene.enter('schedule-post-wizard', { prefill });
```
This is already `ctx.reply` so no change needed.

- [ ] **Step 8: Syntax-check**

```powershell
node --check src/handlers/adminHandler.js
```

Expected: no output.

---

## Task 4: Rewrite handleStock + Add handleAuctions

**Files:**
- Modify: `src/handlers/adminHandler.js`

- [ ] **Step 1: Add paginator import at top of adminHandler.js**

After the last import line, add:
```js
import { buildPageMessage, PAGE_SIZE } from '../utils/paginator.js';
```

- [ ] **Step 2: Rewrite `handleStock`**

Replace the entire existing `handleStock` function:
```js
// ── /stock ────────────────────────────────────────────────────────
export async function handleStock(ctx, page = 0) {
  const products = await ProductModel.listActive();

  const { text, markup } = buildPageMessage({
    items:     products,
    page,
    entityKey: 'stock',
    title:     '📦 *Stock Overview*',
    emptyText: 'No active listings.',
    renderItem: (p) => {
      const emoji = p.status === 'sold_out' ? '🔴' : '🟢';
      return (
        `${emoji} *${p.name}*\n` +
        `$${parseFloat(p.price).toFixed(2)} · ${p.quantity_remaining}/${p.quantity_total} left · ${p.confirmed_claims} claimed`
      );
    },
    buildItemButtons: (p) => [
      Markup.button.callback('📋 Claims', `act:claims:${p.telegram_message_id}`),
      Markup.button.callback('🗑️ Cancel', `act:cancel_prod:${p.telegram_message_id}`),
    ],
  });

  const opts = { parse_mode: 'Markdown', ...markup };
  return ctx.callbackQuery
    ? ctx.editMessageText(text, opts)
    : ctx.reply(text, opts);
}
```

- [ ] **Step 3: Add `handleAuctions` after `handleStock`**

```js
// ── /auctions ─────────────────────────────────────────────────────
export async function handleAuctions(ctx, page = 0) {
  const auctions = await AuctionModel.listActive();

  const { text, markup } = buildPageMessage({
    items:     auctions,
    page,
    entityKey: 'auctions',
    title:     '🔨 *Active Auctions*',
    emptyText: 'No active or upcoming auctions.',
    renderItem: (a) => {
      const statusEmoji = a.status === 'active' ? '🟢' : '🕐';
      const endStr      = new Date(a.end_time).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
      const bidStr      = a.current_bid ? `$${parseFloat(a.current_bid).toFixed(2)}` : `$${parseFloat(a.starting_bid).toFixed(2)} start`;
      return `${statusEmoji} *${a.name}*\n${bidStr} · ends ${endStr} SGT`;
    },
    buildItemButtons: (a) => {
      const btns = [Markup.button.callback('📊 Bids', `act:bids:${a.telegram_message_id}`)];
      if (a.status === 'active')                         btns.push(Markup.button.callback('⏹ End Early', `act:end_auction:${a.telegram_message_id}`));
      if (a.status === 'active' || a.status === 'upcoming') btns.push(Markup.button.callback('❌ Cancel', `act:cancel_auction:${a.telegram_message_id}`));
      return btns;
    },
  });

  const opts = { parse_mode: 'Markdown', ...markup };
  return ctx.callbackQuery
    ? ctx.editMessageText(text, opts)
    : ctx.reply(text, opts);
}
```

- [ ] **Step 4: Syntax-check**

```powershell
node --check src/handlers/adminHandler.js
```

Expected: no output.

---

## Task 5: Rewrite handleListScheduled + handlePending

**Files:**
- Modify: `src/handlers/adminHandler.js`

- [ ] **Step 1: Rewrite `handleListScheduled`**

Replace the entire existing function:
```js
export async function handleListScheduled(ctx, page = 0) {
  const posts = await ScheduledPostModel.listPending();

  const typeEmoji = { free_form: '📝', product_listing: '📦', auction_listing: '🔨' };

  const { text, markup } = buildPageMessage({
    items:     posts,
    page,
    entityKey: 'scheduled',
    title:     '📅 *Scheduled Posts*',
    emptyText: 'No scheduled posts pending.',
    renderItem: (p) => {
      const emoji = typeEmoji[p.type] || '📅';
      const label = p.product_name || p.auction_name
        || (p.content ? p.content.slice(0, 40) + (p.content.length > 40 ? '…' : '') : '—');
      const when = new Date(p.scheduled_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
      return `${emoji} *#${p.id}* — ${label}\n${when} SGT`;
    },
    buildItemButtons: (p) => [
      Markup.button.callback('✏️ Edit', `act:edit_sched:${p.id}`),
      Markup.button.callback('🗑️ Delete', `act:del_sched:${p.id}`),
    ],
  });

  const opts = { parse_mode: 'Markdown', ...markup };
  return ctx.callbackQuery
    ? ctx.editMessageText(text, opts)
    : ctx.reply(text, opts);
}
```

- [ ] **Step 2: Rewrite `handlePending`**

Replace the entire existing function:
```js
export async function handlePending(ctx, page = 0) {
  const rows = await InvoiceModel.getPendingSummary();

  const { text, markup } = buildPageMessage({
    items:     rows,
    page,
    entityKey: 'pending',
    title:     '💰 *Pending Invoices*',
    emptyText: '✅ No pending uninvoiced claims.',
    renderItem: (r) => {
      const handle = r.username ? `@${r.username}` : r.first_name || `ID:${r.telegram_id}`;
      return `👤 *${handle}*\n${r.claim_count} item(s) · $${r.total}`;
    },
    buildItemButtons: (r) => [
      Markup.button.callback('🧾 Send Invoice', `act:invoice:${r.telegram_id}`),
    ],
  });

  const opts = { parse_mode: 'Markdown', ...markup };
  return ctx.callbackQuery
    ? ctx.editMessageText(text, opts)
    : ctx.reply(text, opts);
}
```

- [ ] **Step 3: Syntax-check**

```powershell
node --check src/handlers/adminHandler.js
```

Expected: no output.

---

## Task 6: Update /help Text

**Files:**
- Modify: `src/handlers/adminHandler.js` — `handleHelp`

- [ ] **Step 1: Update the help text**

Replace the existing `handleHelp` function body with:
```js
export function handleHelp(ctx) {
  return ctx.reply(
    `📋 *Admin Command Reference*\n\n` +

    `*📦 Products*\n` +
    `Forward a channel post → choose Product or Auction\n` +
    `\`/newproduct <msg\\_id> <price> <qty> <name>\` — manual\n` +
    `/stock — paginated list with Claims + Cancel buttons\n\n` +

    `*🔨 Auctions*\n` +
    `/auctions — paginated list with Bids + End + Cancel buttons\n` +
    `/createauction — wizard\n\n` +

    `*📊 Status*\n` +
    `/stock — products & stock levels\n` +
    `/pending — uninvoiced claims with Send Invoice buttons\n` +
    `/claims <post\\_id> — who claimed a product (direct)\n\n` +

    `*🧾 Invoices*\n` +
    `/invoice @username — generate invoice for one user\n` +
    `/invoiceall — generate for all pending users\n` +
    `/invoicehistory — paid & cancelled\n` +
    `/confirmpaid <id> — mark as paid (also: button on invoice)\n` +
    `/deleteinvoice <id> — cancel invoice\n\n` +

    `*🎁 Giveaway*\n` +
    `/newgiveaway — start pool\n` +
    `/drawgiveaway — draw winner\n` +
    `/giveawaystats — pool stats\n` +
    `/cleargiveaway — cancel pool\n\n` +

    `*📅 Scheduling*\n` +
    `/schedulepost — schedule a channel post\n` +
    `/listscheduled — pending posts with Edit + Delete buttons\n\n` +

    `*⚙️ Other*\n` +
    `/start — welcome & workflow\n` +
    `/cancel — exit any wizard\n` +
    `/help — this reference`,
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] **Step 2: Syntax-check**

```powershell
node --check src/handlers/adminHandler.js
```

Expected: no output.

---

## Task 7: Wire Callbacks + /auctions Command in index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add `handleAuctions` to the import from adminHandler**

Find the existing adminHandler import block and add `handleAuctions`:
```js
import {
  handleNewProduct, handleStock, handleViewClaims,
  handleSendInvoice, handleSendAllInvoices, handlePending,
  handleAdminStart, handleHelp,
  handleConfirmPaid, handleDeleteInvoice, handleDeleteInvoiceConfirm,
  handleInvoiceHistory, cancelInvoiceById, confirmPaidById,
  handleAuctionBids, handleEndAuction, handleCancelAuction,
  handleDrawGiveaway, handleGiveawayStats, handleClearGiveaway, handleClearGiveawayConfirm,
  handleListScheduled, handleDeleteScheduled, handleEditScheduled,
  handleAuctions,
} from './handlers/adminHandler.js';
```

- [ ] **Step 2: Add `/auctions` command**

After the existing `/stock` command line:
```js
bot.command('stock',    adminOnly, handleStock);
```
add:
```js
bot.command('auctions', adminOnly, handleAuctions);
```

- [ ] **Step 3: Add `pg:` pagination block to the callback_query handler**

In the `bot.on('callback_query', ...)` block, after the `await ctx.answerCbQuery()` line and before the first `if (data.startsWith(...))`, add:

```js
  // ── Pagination ──────────────────────────────────────────────────
  if (data.startsWith('pg:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const parts = data.split(':');
    const entity = parts[1];
    const page   = parseInt(parts[2], 10);
    if (entity === 'stock')     return handleStock(ctx, page);
    if (entity === 'auctions')  return handleAuctions(ctx, page);
    if (entity === 'scheduled') return handleListScheduled(ctx, page);
    if (entity === 'pending')   return handlePending(ctx, page);
    return;
  }
```

- [ ] **Step 4: Add `act:` action blocks to the callback_query handler**

After the `pg:` block (and before the existing `invoice:paid:` block), add:

```js
  // ── Product actions ──────────────────────────────────────────────
  if (data.startsWith('act:claims:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const msgId = parseInt(data.split(':')[2], 10);
    return handleViewClaims(ctx, msgId);
  }

  if (data.startsWith('act:cancel_prod:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const msgId   = parseInt(data.split(':')[2], 10);
    const product = await ProductModel.findByMessageId(msgId);
    if (!product)                       return ctx.reply('⚠️ Product not found.');
    if (product.status === 'cancelled') return ctx.reply('⚠️ Already cancelled.');
    await ProductModel.cancel(product.id);
    return ctx.reply(
      `🗑️ *${product.name}* marked as cancelled.\n\nRemember to delete the post from the channel manually.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Auction actions ──────────────────────────────────────────────
  if (data.startsWith('act:bids:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const msgId = parseInt(data.split(':')[2], 10);
    return handleAuctionBids(ctx, msgId);
  }

  if (data.startsWith('act:end_auction:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const msgId   = parseInt(data.split(':')[2], 10);
    return handleEndAuction(ctx, msgId);
  }

  if (data.startsWith('act:cancel_auction:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const msgId = parseInt(data.split(':')[2], 10);
    return handleCancelAuction(ctx, msgId);
  }

  // ── Scheduled post actions ────────────────────────────────────────
  if (data.startsWith('act:del_sched:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const id = parseInt(data.split(':')[2], 10);
    return handleDeleteScheduled(ctx, id);
  }

  if (data.startsWith('act:edit_sched:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const id = parseInt(data.split(':')[2], 10);
    return handleEditScheduled(ctx, id);
  }

  // ── Invoice actions ───────────────────────────────────────────────
  if (data.startsWith('act:invoice:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const telegramId = parseInt(data.split(':')[2], 10);
    try {
      const invoice = await generateInvoiceForAdmin(ctx.telegram, ctx.from.id, telegramId);
      if (!invoice) return ctx.reply(`ℹ️ No pending claims for this user.`);
      return ctx.reply(`✅ Invoice #${invoice.id} sent.`);
    } catch (err) {
      console.error('[callback] invoice error:', err.message);
      const reason = err.message?.includes("bot can't initiate")
        ? 'User must send /start to the bot first'
        : err.message;
      return ctx.reply(`❌ Failed: ${reason}`);
    }
  }
```

- [ ] **Step 5: Add `generateInvoiceForAdmin` to the import from invoiceService**

Find:
```js
import { generateInvoiceForAdmin, generateAllInvoicesForAdmin } from './services/invoiceService.js';
```

This import may already be in index.js (it was previously only imported in adminHandler.js). Check if it exists; if not, add it. If it's already there, skip this step.

If it's not imported in index.js yet, add it:
```js
import { generateInvoiceForAdmin } from './services/invoiceService.js';
```

- [ ] **Step 6: Syntax-check**

```powershell
node --check src/index.js
```

Expected: no output.

---

## Task 8: Update Forward-to-Act Handler

When a channel post that is already registered is forwarded, show action buttons instead of the current plain-text warning.

**Files:**
- Modify: `src/index.js` — forward handler in `bot.on('message', ...)`

- [ ] **Step 1: Replace the "already registered" branch**

Find the forward handler block (the `bot.on('message', ...)` that handles forwarded channel posts). Replace:

```js
  const { rows } = await query(
    'SELECT post_type FROM post_registry WHERE telegram_message_id = $1',
    [messageId]
  );
  if (rows[0]) {
    return ctx.reply(
      `⚠️ Post #${messageId} is already registered as a *${rows[0].post_type}*.`,
      { parse_mode: 'Markdown' }
    );
  }
```

with:

```js
  const { rows } = await query(
    `SELECT pr.post_type, pr.ref_id,
            p.name  AS product_name,  p.status AS product_status,
            a.name  AS auction_name,  a.status AS auction_status
     FROM post_registry pr
     LEFT JOIN products p ON pr.post_type = 'product' AND p.id = pr.ref_id
     LEFT JOIN auctions a ON pr.post_type = 'auction' AND a.id = pr.ref_id
     WHERE pr.telegram_message_id = $1`,
    [messageId]
  );

  if (rows[0]) {
    const reg = rows[0];

    if (reg.post_type === 'product') {
      const statusEmoji = reg.product_status === 'sold_out' ? '🔴' : '🟢';
      return ctx.reply(
        `${statusEmoji} *${reg.product_name}* is registered as a product.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('📋 View Claims',    `act:claims:${messageId}`),
            Markup.button.callback('🗑️ Cancel Listing', `act:cancel_prod:${messageId}`),
          ]]),
        }
      );
    }

    if (reg.post_type === 'auction') {
      const statusEmoji = reg.auction_status === 'active' ? '🟢' : '🕐';
      const btns = [Markup.button.callback('📊 View Bids', `act:bids:${messageId}`)];
      if (reg.auction_status === 'active')                              btns.push(Markup.button.callback('⏹ End Early',   `act:end_auction:${messageId}`));
      if (reg.auction_status === 'active' || reg.auction_status === 'upcoming') btns.push(Markup.button.callback('❌ Cancel', `act:cancel_auction:${messageId}`));
      return ctx.reply(
        `${statusEmoji} *${reg.auction_name}* is registered as an auction.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([btns]) }
      );
    }
  }
```

- [ ] **Step 2: Syntax-check**

```powershell
node --check src/index.js
```

Expected: no output.

---

## Task 9: End-to-End Manual Test + Push

- [ ] **Step 1: Start the bot locally**

```powershell
npm run dev
```

- [ ] **Step 2: Test `/stock`**

Send `/stock` in admin DM.
Expected: paginated message with 📋 Claims and 🗑️ Cancel buttons per product. If > 5 products, Next button appears.

- [ ] **Step 3: Test `/auctions`**

Send `/auctions` in admin DM.
Expected: paginated list of upcoming/active auctions with Bids / End Early / Cancel buttons. If no auctions: "No active or upcoming auctions."

- [ ] **Step 4: Test `/listscheduled`**

Send `/listscheduled` in admin DM.
Expected: paginated scheduled posts with ✏️ Edit and 🗑️ Delete buttons.

- [ ] **Step 5: Test `/pending`**

Send `/pending` in admin DM.
Expected: paginated list of users with 🧾 Send Invoice button per user.

- [ ] **Step 6: Test pagination**

If you have > 5 products, tap ➡️ Next. Expected: same message edited to show next page; ⬅️ Prev button appears.

- [ ] **Step 7: Test Claims button**

From `/stock`, tap 📋 Claims on a product. Expected: new message listing who claimed that product.

- [ ] **Step 8: Test forward-to-act (product)**

Forward a channel post that is registered as a product to admin DM. Expected: product name + 📋 View Claims and 🗑️ Cancel Listing buttons (instead of plain warning text).

- [ ] **Step 9: Test forward-to-act (auction)**

Forward a channel post registered as an auction. Expected: auction name + 📊 View Bids (+ End Early if active) (+ Cancel if active/upcoming).

- [ ] **Step 10: Push**

```powershell
git push
```

---

## Self-Review

**Spec coverage:**
- `/stock` with pagination + Claims + Cancel buttons ✓ (Task 4)
- `/auctions` new command with pagination + Bids + End + Cancel buttons ✓ (Task 4)
- `/listscheduled` with pagination + Edit + Delete buttons ✓ (Task 5)
- `/pending` with pagination + Send Invoice button ✓ (Task 5)
- Forward-to-act for registered products ✓ (Task 8)
- Forward-to-act for registered auctions ✓ (Task 8)
- Show active + sold_out products (not cancelled) ✓ — `ProductModel.listActive()` already filters this way
- Show upcoming + active auctions (not ended/cancelled) ✓ — `AuctionModel.listActive()` added in Task 2
- Page size 5, single message edited in-place on pagination ✓
- Prev/Next only when needed ✓

**Placeholder scan:** None found — all steps contain exact code.

**Type consistency:**
- `buildPageMessage` returns `{ text, markup }` — used as `...markup` in all handlers ✓
- Callback data uses `telegram_message_id` for products/auctions, DB `id` for scheduled posts, `telegram_id` for users — consistent between button creation and callback parsing ✓
- `handleStock(ctx, page)`, `handleAuctions(ctx, page)`, `handleListScheduled(ctx, page)`, `handlePending(ctx, page)` — all called as `handler(ctx, page)` in the `pg:` callback block ✓
- Override parameters: `overrideMsgId` for message-ID–keyed lookups, `overrideId` for DB-ID–keyed lookups ✓
