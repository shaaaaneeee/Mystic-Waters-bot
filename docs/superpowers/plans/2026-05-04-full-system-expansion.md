# Full System Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add registration gate, auction engine, giveaway system, scheduled posting, admin-only invoice rework, paid confirmation, and delete invoice to the existing working Mystic Waters bot.

**Architecture:** Build on top of existing flat src/ structure. New subsystems go in src/modules/{registration,auction,giveaway,scheduler}/. Existing files expanded in-place. All state persisted in PostgreSQL; Redis used for distributed locks only.

**Tech Stack:** Node.js 20 ESM, Telegraf 4.16.3, pg, ioredis, node-cron, dotenv

---

## File Map

**Create:**
- `src/modules/registration/registrationService.js` — phone gate, registration state machine
- `src/modules/auction/auctionService.js` — bid processing, lifecycle, anti-snipe
- `src/modules/auction/auctionWizard.js` — WizardScene for /createauction
- `src/modules/giveaway/giveawayService.js` — entry creation, draw, stats
- `src/modules/scheduler/schedulerService.js` — cron engine, DB-backed queue
- `src/modules/scheduler/scheduleWizard.js` — WizardScene for /schedulepost
- `src/models/auction.js` — AuctionModel CRUD
- `src/models/auctionBid.js` — AuctionBidModel CRUD
- `src/models/giveaway.js` — GiveawayModel CRUD
- `src/models/scheduledPost.js` — ScheduledPostModel CRUD
- `src/handlers/auctionHandler.js` — bid handler for group comments

**Modify:**
- `src/models/user.js` — add registration field methods
- `src/models/invoice.js` — new status lifecycle, confirmPaid, cancel, restoreStock
- `src/models/claim.js` — update getPendingInvoiceClaims to exclude cancelled invoices
- `src/services/invoiceService.js` — admin-only output, inline keyboard, reworked flow
- `src/services/stockService.js` — add restoreClaimedUnit function
- `src/handlers/adminHandler.js` — add 15 new admin commands
- `src/handlers/claimHandler.js` — add registration gate
- `src/middleware/guards.js` — add registrationRequired export
- `src/scenes/newProductWizard.js` — after product created, register in post_registry
- `src/index.js` — wire all new scenes, handlers, modules, callback_query handler
- `package.json` — add node-cron

---

## Task 1: Install node-cron

**Files:** `package.json`

- [ ] Run: `npm install node-cron`
- [ ] Verify: `node -e "import('node-cron').then(m => console.log('ok', Object.keys(m)))"`
- [ ] Commit: `git add package.json package-lock.json && git commit -m "chore: add node-cron dependency"`

---

## Task 2: Update UserModel — registration fields

**Files:** `src/models/user.js`

- [ ] Replace entire file with:

```js
// src/models/user.js
import { query } from '../../config/database.js';

export const UserModel = {

  async upsert({ telegramId, username, firstName, lastName }, client) {
    const execute = client
      ? (text, params) => client.query(text, params)
      : query;
    const { rows } = await execute(
      `INSERT INTO users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name,
         updated_at = NOW()
       RETURNING *`,
      [telegramId, username || null, firstName || null, lastName || null]
    );
    return rows[0];
  },

  async findByTelegramId(telegramId) {
    const { rows } = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return rows[0] || null;
  },

  async findByUsername(username) {
    const clean = username.replace(/^@/, '').toLowerCase();
    const { rows } = await query(
      'SELECT * FROM users WHERE LOWER(username) = $1 LIMIT 1', [clean]
    );
    return rows[0] || null;
  },

  async setRegistered({ telegramId, phoneNumber }) {
    const { rows } = await query(
      `UPDATE users SET
         phone_number        = $2,
         registered_at       = NOW(),
         registration_status = 'registered',
         updated_at          = NOW()
       WHERE telegram_id = $1
       RETURNING *`,
      [telegramId, phoneNumber]
    );
    return rows[0] || null;
  },

  async upsertAndGetStatus({ telegramId, username, firstName, lastName }) {
    const { rows } = await query(
      `INSERT INTO users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name,
         updated_at = NOW()
       RETURNING *`,
      [telegramId, username || null, firstName || null, lastName || null]
    );
    return rows[0];
  },
};
```

- [ ] Commit: `git add src/models/user.js && git commit -m "feat: add registration fields to UserModel"`

---

## Task 3: Update InvoiceModel — new status lifecycle

**Files:** `src/models/invoice.js`

- [ ] Replace entire file with:

```js
// src/models/invoice.js
import { query, getClient } from '../../config/database.js';

export const InvoiceModel = {

  async createWithClaims({ userId, claims }) {
    const total = claims.reduce((sum, c) => sum + parseFloat(c.price), 0);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const { rows: [invoice] } = await client.query(
        `INSERT INTO invoices (user_id, total_amount, status)
         VALUES ($1, $2, 'active') RETURNING *`,
        [userId, total.toFixed(2)]
      );
      for (const claim of claims) {
        await client.query(
          `INSERT INTO invoice_claims (invoice_id, claim_id) VALUES ($1, $2)`,
          [invoice.id, claim.claim_id]
        );
      }
      await client.query('COMMIT');
      return { ...invoice, claims };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async deleteById(invoiceId) {
    await query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
  },

  async markSent(invoiceId) {
    const { rows } = await query(
      `UPDATE invoices SET sent_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [invoiceId]
    );
    return rows[0];
  },

  async findById(invoiceId) {
    const { rows } = await query(
      `SELECT i.*,
              u.telegram_id, u.username, u.first_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.id = $1`,
      [invoiceId]
    );
    return rows[0] || null;
  },

  async getClaimsForInvoice(invoiceId) {
    const { rows } = await query(
      `SELECT c.id AS claim_id, p.name, p.price, p.telegram_message_id
       FROM invoice_claims ic
       JOIN claims c ON c.id = ic.claim_id
       JOIN products p ON p.id = c.product_id
       WHERE ic.invoice_id = $1
       ORDER BY c.created_at ASC`,
      [invoiceId]
    );
    return rows;
  },

  // Confirm payment — only if status = 'active'. Returns updated invoice or null.
  async confirmPaid({ invoiceId, confirmedByTelegramId }) {
    const { rows } = await query(
      `UPDATE invoices SET
         status             = 'paid',
         paid_at            = NOW(),
         paid_confirmed_by  = $2,
         updated_at         = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [invoiceId, confirmedByTelegramId]
    );
    return rows[0] || null;
  },

  // Cancel invoice — only if status = 'active'.
  // Also removes invoice_claims so claims become re-invoiceable.
  async cancel({ invoiceId, cancelledByTelegramId, reason }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE invoices SET
           status         = 'cancelled',
           cancelled_at   = NOW(),
           cancelled_by   = $2,
           cancel_reason  = $3,
           updated_at     = NOW()
         WHERE id = $1 AND status = 'active'
         RETURNING *`,
        [invoiceId, cancelledByTelegramId, reason || null]
      );

      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      // Remove invoice_claims so claims return to uninvoiced pool
      await client.query(
        `DELETE FROM invoice_claims WHERE invoice_id = $1`,
        [invoiceId]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getPendingSummary() {
    const { rows } = await query(
      `SELECT u.telegram_id, u.username, u.first_name,
              COUNT(c.id) AS claim_count,
              SUM(p.price)::NUMERIC(10,2) AS total
       FROM claims c
       JOIN users u ON u.id = c.user_id
       JOIN products p ON p.id = c.product_id
       WHERE c.status = 'confirmed'
         AND c.id NOT IN (
           SELECT ic.claim_id FROM invoice_claims ic
           JOIN invoices inv ON inv.id = ic.invoice_id
           WHERE inv.status != 'cancelled'
         )
       GROUP BY u.id
       ORDER BY total DESC`
    );
    return rows;
  },

  async listActive() {
    const { rows } = await query(
      `SELECT i.*, u.telegram_id, u.username, u.first_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'active'
       ORDER BY i.created_at DESC`
    );
    return rows;
  },

  async listHistory() {
    const { rows } = await query(
      `SELECT i.*, u.telegram_id, u.username, u.first_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status IN ('paid', 'cancelled')
       ORDER BY i.updated_at DESC
       LIMIT 50`
    );
    return rows;
  },
};
```

- [ ] Update `ClaimModel.getPendingInvoiceClaims` in `src/models/claim.js` to exclude cancelled invoices:

```js
async getPendingInvoiceClaims(userId) {
  const { rows } = await query(
    `SELECT c.id AS claim_id, c.created_at,
            p.name, p.price, p.telegram_message_id
     FROM claims c
     JOIN products p ON p.id = c.product_id
     WHERE c.user_id = $1
       AND c.status = 'confirmed'
       AND c.id NOT IN (
         SELECT ic.claim_id FROM invoice_claims ic
         JOIN invoices inv ON inv.id = ic.invoice_id
         WHERE inv.status != 'cancelled'
       )
     ORDER BY c.created_at ASC`,
    [userId]
  );
  return rows;
},
```

- [ ] Commit: `git add src/models/invoice.js src/models/claim.js && git commit -m "feat: update InvoiceModel for new status lifecycle and ClaimModel fix"`

---

## Task 4: Registration middleware

**Files:** `src/middleware/guards.js`

- [ ] Add `registrationRequired` to `guards.js`:

```js
// src/middleware/guards.js
import 'dotenv/config';
import { UserModel } from '../models/user.js';

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean)
);

const COMMENT_GROUP_ID = parseInt(process.env.COMMENT_GROUP_ID, 10);

export function isAdmin(userId) {
  return ADMIN_IDS.has(userId);
}

export function adminOnly(ctx, next) {
  if (!ADMIN_IDS.has(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
  return next();
}

export function commentOnly(ctx, next) {
  const msg = ctx.message;
  if (!msg) return;
  if (msg.chat.id !== COMMENT_GROUP_ID) return;
  if (!msg.reply_to_message) return;

  const fwd = msg.reply_to_message.forward_from_message_id;
  const fwdChat = msg.reply_to_message.forward_from_chat?.id
               || msg.reply_to_message.sender_chat?.id;

  if (!fwd || String(fwdChat) !== String(process.env.CHANNEL_ID)) return;

  ctx.channelPostId = fwd;
  return next();
}

// Checks registration before allowing claim/bid.
// Upserts user row so we always have a record.
export async function registrationRequired(ctx, next) {
  const from = ctx.from;
  if (!from) return;

  const user = await UserModel.upsertAndGetStatus({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
  });

  if (user.registration_status === 'registered') {
    ctx.dbUser = user;
    return next();
  }

  const botUsername = ctx.botInfo?.username;
  const link = botUsername
    ? `https://t.me/${botUsername}?start=register`
    : 'the bot DM';

  return ctx.reply(
    `👋 To participate, please register first → ${link}\n\nIt takes 10 seconds.`,
    { reply_to_message_id: ctx.message?.message_id }
  );
}
```

- [ ] Commit: `git add src/middleware/guards.js && git commit -m "feat: add registrationRequired middleware"`

---

## Task 5: Registration service + flow

**Files:** `src/modules/registration/registrationService.js`

- [ ] Create directory: `src/modules/registration/`
- [ ] Create `src/modules/registration/registrationService.js`:

```js
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
  const payload = ctx.startPayload; // 'register' or empty

  // Upsert so we always have a record
  const user = await UserModel.upsertAndGetStatus({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
  });

  if (user.registration_status === 'registered') {
    return ctx.reply(BUYER_WELCOME_REGISTERED, { parse_mode: 'Markdown' });
  }

  // Show registration prompt with contact button
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
```

- [ ] Commit: `git add src/modules/registration/ && git commit -m "feat: registration service and welcome messages"`

---

## Task 6: Update stockService — add restoreClaimedUnit

**Files:** `src/services/stockService.js`

- [ ] Add `restoreClaimedUnit` function at the bottom of `stockService.js`:

```js
// Add after the existing attemptClaim export

const RESTORE_LOCK_PREFIX = 'stock:restore:product:';

export async function restoreClaimedUnit(productId) {
  const key = RESTORE_LOCK_PREFIX + productId;
  let lockAcquired = false;

  try {
    const result = await redis.set(key, '1', 'NX', 'PX', LOCK_TTL_MS);
    lockAcquired = result === 'OK';
    if (!lockAcquired) throw new Error(`Could not acquire restore lock for product ${productId}`);

    const { rows } = await query(
      `UPDATE products
       SET quantity_remaining = LEAST(quantity_remaining + 1, quantity_total),
           status = CASE
             WHEN status = 'sold_out' AND quantity_remaining + 1 > 0 THEN 'active'
             ELSE status
           END,
           updated_at = NOW()
       WHERE id = $1
         AND quantity_remaining < quantity_total
       RETURNING *`,
      [productId]
    );
    return rows[0] || null;
  } finally {
    if (lockAcquired) await redis.del(key);
  }
}
```

- [ ] Add `import { query } from '../../config/database.js';` if not already present (it's already there via getClient import — just add `query` to destructure).

  The current import in stockService.js is: `import { getClient } from '../../config/database.js';`
  Update to: `import { getClient, query } from '../../config/database.js';`

- [ ] Commit: `git add src/services/stockService.js && git commit -m "feat: add restoreClaimedUnit to stockService"`

---

## Task 7: Rework invoiceService — admin-only output with inline keyboard

**Files:** `src/services/invoiceService.js`

- [ ] Replace entire file:

```js
// src/services/invoiceService.js
import { Markup } from 'telegraf';
import { ClaimModel } from '../models/claim.js';
import { InvoiceModel } from '../models/invoice.js';
import { UserModel } from '../models/user.js';

const PAYNOW_NUMBER  = '97296056';
const BUSINESS_NAME  = 'Mystic Waters';
const SELFCOLLECT_POSTAL = '520381';
const MAIL_FEE       = 3.50;
const PAYMENT_HOURS  = 24;

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

// Generates invoice and sends to admin DM only.
export async function generateInvoiceForAdmin(bot, adminTelegramId, telegramUserId) {
  const user = await UserModel.findByTelegramId(telegramUserId);
  if (!user) throw new Error(`User not found: telegramId=${telegramUserId}`);

  const claims = await ClaimModel.getPendingInvoiceClaims(user.id);
  if (claims.length === 0) return null;

  const invoice = await InvoiceModel.createWithClaims({ userId: user.id, claims });
  const message = formatInvoiceMessage(user, claims, invoice.id);

  try {
    await bot.sendMessage(adminTelegramId, message, {
      parse_mode: 'Markdown',
      ...invoiceKeyboard(invoice.id),
    });
  } catch (err) {
    await InvoiceModel.deleteById(invoice.id);
    throw err;
  }

  await InvoiceModel.markSent(invoice.id);
  return invoice;
}

// Send invoices for ALL pending users — to admin only.
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

// Keep old name as alias so existing adminHandler call sites work during transition
export { generateInvoiceForAdmin as sendInvoiceToUser };
export { generateAllInvoicesForAdmin as sendAllPendingInvoices };
```

- [ ] Commit: `git add src/services/invoiceService.js && git commit -m "feat: rework invoiceService — admin-only with inline keyboard"`

---

## Task 8: Add new admin commands to adminHandler

**Files:** `src/handlers/adminHandler.js`

- [ ] Add imports at top of adminHandler.js (after existing imports):

```js
import { generateInvoiceForAdmin, generateAllInvoicesForAdmin } from '../services/invoiceService.js';
import { restoreClaimedUnit } from '../services/stockService.js';
import { GiveawayModel } from '../models/giveaway.js';
import { GiveawayService } from '../modules/giveaway/giveawayService.js';
```

- [ ] Update `handleNewProduct` to also write to `post_registry`:

```js
// After ProductModel.create() call, add:
await query(
  `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
   VALUES ($1, 'product', $2) ON CONFLICT DO NOTHING`,
  [messageId, product.id]
);
```

  Add `import { query } from '../../config/database.js';` at top of adminHandler.js.

- [ ] Update `handleSendInvoice` to call `generateInvoiceForAdmin` and pass `ctx.from.id` as admin:

```js
export async function handleSendInvoice(ctx) {
  const args = ctx.message.text.split(' ');
  const rawId = args[1];

  if (!rawId) {
    return ctx.reply(
      'Usage: `/invoice @username` or `/invoice <telegram_id>`',
      { parse_mode: 'Markdown' }
    );
  }

  let telegramId;
  let displayHandle = rawId;

  if (rawId.startsWith('@')) {
    const user = await UserModel.findByUsername(rawId);
    if (!user) {
      return ctx.reply(`❌ No user found with username ${rawId}.\nThey must have claimed at least once.`);
    }
    telegramId = user.telegram_id;
  } else {
    telegramId = parseInt(rawId, 10);
    if (isNaN(telegramId)) {
      return ctx.reply('❌ Invalid input. Use `@username` or a numeric Telegram ID.', { parse_mode: 'Markdown' });
    }
  }

  try {
    const invoice = await generateInvoiceForAdmin(ctx.telegram, ctx.from.id, telegramId);

    if (!invoice) {
      return ctx.reply(`ℹ️ No pending claims for ${displayHandle}.`);
    }

    return ctx.reply(`✅ Invoice #${invoice.id} generated above for ${displayHandle}.`);
  } catch (err) {
    console.error('[adminHandler] invoice error:', err.message);
    const reason = err.message?.includes("bot can't initiate")
      ? `${displayHandle} must send /start to the bot first`
      : err.message;
    return ctx.reply(`❌ Failed to generate invoice: ${reason}`);
  }
}
```

- [ ] Update `handleSendAllInvoices` to use new service:

```js
export async function handleSendAllInvoices(ctx) {
  await ctx.reply('📤 Generating invoices for all pending users...');
  const results = await generateAllInvoicesForAdmin(ctx.telegram, ctx.from.id);

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success);

  let summary = `✅ Generated ${succeeded} invoice(s) above.`;
  if (failed.length > 0) {
    const failLines = failed.map(f => `  • ${f.handle} — ${f.error}`);
    summary += `\n⚠️ Failed:\n${failLines.join('\n')}`;
  }
  return ctx.reply(summary);
}
```

- [ ] Add `/confirmpaid` handler:

```js
export async function handleConfirmPaid(ctx) {
  const args = ctx.message.text.split(' ');
  const rawId = args[1];

  if (!rawId) {
    return ctx.reply('Usage: `/confirmpaid <invoice_id>`', { parse_mode: 'Markdown' });
  }

  const invoiceId = parseInt(rawId, 10);
  if (isNaN(invoiceId)) {
    return ctx.reply('❌ Invalid invoice ID.');
  }

  return confirmPaidById(ctx, invoiceId);
}

export async function confirmPaidById(ctx, invoiceId) {
  const invoice = await InvoiceModel.confirmPaid({
    invoiceId,
    confirmedByTelegramId: ctx.from.id,
  });

  if (!invoice) {
    return ctx.reply(
      `❌ Invoice #${invoiceId} not found, already paid, or cancelled.`
    );
  }

  // Trigger giveaway entries if active pool exists
  try {
    const activePool = await GiveawayModel.getActivePool();
    if (activePool) {
      const claims = await InvoiceModel.getClaimsForInvoice(invoiceId);
      await GiveawayService.addEntries({ pool: activePool, invoiceId, claims, userId: invoice.user_id });
    }
  } catch (err) {
    console.error('[adminHandler] giveaway entry error:', err.message);
  }

  return ctx.reply(
    `✅ Invoice #${invoiceId} marked as *paid*.\n` +
    `Confirmed by you at ${new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT.`,
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] Add `/deleteinvoice` handler:

```js
// Session key for pending cancellations
const PENDING_CANCEL = new Map(); // invoiceId → { adminId, timestamp }

export async function handleDeleteInvoice(ctx) {
  const args = ctx.message.text.split(' ');
  const rawId = args[1];

  if (!rawId) {
    return ctx.reply('Usage: `/deleteinvoice <invoice_id>`', { parse_mode: 'Markdown' });
  }

  const invoiceId = parseInt(rawId, 10);
  if (isNaN(invoiceId)) return ctx.reply('❌ Invalid invoice ID.');

  const invoice = await InvoiceModel.findById(invoiceId);
  if (!invoice) return ctx.reply(`❌ Invoice #${invoiceId} not found.`);
  if (invoice.status !== 'active') {
    return ctx.reply(`❌ Invoice #${invoiceId} is already ${invoice.status}. Only active invoices can be cancelled.`);
  }

  const handle = invoice.username ? `@${invoice.username}` : (invoice.first_name || `ID:${invoice.telegram_id}`);
  PENDING_CANCEL.set(invoiceId, { adminId: ctx.from.id, ts: Date.now() });

  return ctx.reply(
    `⚠️ Cancel invoice #${invoiceId} for ${handle} ($${parseFloat(invoice.total_amount).toFixed(2)})?\n\n` +
    `Reply \`CONFIRM\` to proceed, or ignore to abort.\n` +
    `_Optional: \`CONFIRM reason text\`_`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleDeleteInvoiceConfirm(ctx) {
  const text = ctx.message?.text?.trim() || '';
  if (!text.toUpperCase().startsWith('CONFIRM')) return;

  // Find pending cancel for this admin
  const adminId = ctx.from.id;
  let invoiceId = null;
  for (const [id, data] of PENDING_CANCEL.entries()) {
    if (data.adminId === adminId && Date.now() - data.ts < 120_000) {
      invoiceId = id;
      break;
    }
  }

  if (!invoiceId) return; // no pending cancel — ignore CONFIRM

  const reason = text.length > 7 ? text.slice(8).trim() : null;
  PENDING_CANCEL.delete(invoiceId);

  return cancelInvoiceById(ctx, invoiceId, reason);
}

export async function cancelInvoiceById(ctx, invoiceId, reason) {
  // Get claims before cancelling (for stock restore)
  const claims = await InvoiceModel.getClaimsForInvoice(invoiceId);

  const cancelled = await InvoiceModel.cancel({
    invoiceId,
    cancelledByTelegramId: ctx.from.id,
    reason,
  });

  if (!cancelled) {
    return ctx.reply(`❌ Invoice #${invoiceId} could not be cancelled (not active or not found).`);
  }

  // Restore stock for each claim
  const restoreResults = await Promise.allSettled(
    claims.map(c =>
      query(
        `SELECT p.id FROM products p JOIN claims cl ON cl.product_id = p.id WHERE cl.id = $1`,
        [c.claim_id]
      ).then(r => r.rows[0]?.id).then(pid => pid ? restoreClaimedUnit(pid) : null)
    )
  );

  const failedRestores = restoreResults.filter(r => r.status === 'rejected').length;

  let msg = `✅ Invoice #${invoiceId} cancelled. ${claims.length} claim(s) returned to invoice queue.`;
  if (failedRestores > 0) msg += `\n⚠️ ${failedRestores} stock restore(s) failed — check manually.`;
  if (reason) msg += `\n_Reason: ${reason}_`;

  return ctx.reply(msg, { parse_mode: 'Markdown' });
}
```

- [ ] Add `import { query } from '../../config/database.js';` and `import { InvoiceModel } from '../models/invoice.js';` to adminHandler.js imports (InvoiceModel already there, add query).

- [ ] Add `/invoicehistory` handler:

```js
export async function handleInvoiceHistory(ctx) {
  const rows = await InvoiceModel.listHistory();

  if (rows.length === 0) return ctx.reply('No invoice history yet.');

  const lines = rows.map(r => {
    const handle = r.username ? `@${r.username}` : (r.first_name || `ID:${r.telegram_id}`);
    const emoji = r.status === 'paid' ? '✅' : '❌';
    const date = new Date(r.updated_at).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });
    return `${emoji} #${r.id} — ${handle} — $${parseFloat(r.total_amount).toFixed(2)} — ${date}`;
  });

  return ctx.reply(
    `📋 *Invoice History* (last 50)\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] Commit: `git add src/handlers/adminHandler.js && git commit -m "feat: add confirmpaid, deleteinvoice, invoicehistory handlers"`

---

## Task 9: Auction models

**Files:** `src/models/auction.js`, `src/models/auctionBid.js`

- [ ] Create `src/models/auction.js`:

```js
// src/models/auction.js
import { query, getClient } from '../../config/database.js';

export const AuctionModel = {

  async create({ telegramMessageId, name, description, startingBid, minIncrement, startTime, endTime, createdBy }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows: [auction] } = await client.query(
        `INSERT INTO auctions
           (telegram_message_id, name, description, starting_bid, min_increment,
            start_time, end_time, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
           CASE WHEN $6 IS NULL OR $6 <= NOW() THEN 'active' ELSE 'upcoming' END)
         RETURNING *`,
        [telegramMessageId, name, description || null, startingBid, minIncrement,
         startTime || null, endTime, createdBy]
      );

      await client.query(
        `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
         VALUES ($1, 'auction', $2) ON CONFLICT DO NOTHING`,
        [telegramMessageId, auction.id]
      );

      await client.query('COMMIT');
      return auction;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findByMessageId(telegramMessageId) {
    const { rows } = await query(
      'SELECT * FROM auctions WHERE telegram_message_id = $1',
      [telegramMessageId]
    );
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await query('SELECT * FROM auctions WHERE id = $1', [id]);
    return rows[0] || null;
  },

  // Activate upcoming auctions whose start_time has passed
  async activateDue() {
    const { rows } = await query(
      `UPDATE auctions SET status = 'active', updated_at = NOW()
       WHERE status = 'upcoming' AND start_time <= NOW()
       RETURNING *`
    );
    return rows;
  },

  // End active auctions whose end_time has passed
  async endDue() {
    const { rows } = await query(
      `UPDATE auctions a SET
         status         = 'ended',
         ended_at       = NOW(),
         winner_user_id = (
           SELECT user_id FROM auction_bids
           WHERE auction_id = a.id AND is_winning = TRUE
           LIMIT 1
         ),
         winner_bid     = a.current_bid,
         updated_at     = NOW()
       WHERE a.status = 'active' AND a.end_time <= NOW()
       RETURNING a.*`
    );
    return rows;
  },

  // Atomically update bid — returns updated auction or null if bid invalid
  async placeBid({ auctionId, userId, amount }, client) {
    const { rows } = await client.query(
      `UPDATE auctions SET
         current_bid       = $3,
         current_leader_id = $2,
         end_time          = CASE
           WHEN end_time - NOW() < INTERVAL '2 minutes'
           THEN end_time + INTERVAL '2 minutes'
           ELSE end_time
         END,
         updated_at = NOW()
       WHERE id = $1
         AND status = 'active'
         AND (current_bid IS NULL OR $3 >= current_bid + min_increment)
         AND $3 >= starting_bid
       RETURNING *`,
      [auctionId, userId, amount]
    );
    return rows[0] || null;
  },

  async cancel(auctionId) {
    const { rows } = await query(
      `UPDATE auctions SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status IN ('upcoming','active') RETURNING *`,
      [auctionId]
    );
    return rows[0] || null;
  },

  async forceEnd(auctionId) {
    const { rows } = await query(
      `UPDATE auctions SET
         end_time   = NOW(),
         updated_at = NOW()
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [auctionId]
    );
    return rows[0] || null;
  },
};
```

- [ ] Create `src/models/auctionBid.js`:

```js
// src/models/auctionBid.js
import { query } from '../../config/database.js';

export const AuctionBidModel = {

  async insert({ auctionId, userId, amount }, client) {
    // Clear previous winning flag for this auction
    await client.query(
      `UPDATE auction_bids SET is_winning = FALSE WHERE auction_id = $1`,
      [auctionId]
    );
    const { rows } = await client.query(
      `INSERT INTO auction_bids (auction_id, user_id, amount, is_winning)
       VALUES ($1, $2, $3, TRUE) RETURNING *`,
      [auctionId, userId, amount]
    );
    return rows[0];
  },

  async listForAuction(auctionId) {
    const { rows } = await query(
      `SELECT ab.*, u.username, u.first_name, u.telegram_id
       FROM auction_bids ab
       JOIN users u ON u.id = ab.user_id
       WHERE ab.auction_id = $1
       ORDER BY ab.amount DESC, ab.created_at ASC`,
      [auctionId]
    );
    return rows;
  },
};
```

- [ ] Commit: `git add src/models/auction.js src/models/auctionBid.js && git commit -m "feat: AuctionModel and AuctionBidModel"`

---

## Task 10: Auction service + wizard

**Files:** `src/modules/auction/auctionService.js`, `src/modules/auction/auctionWizard.js`, `src/handlers/auctionHandler.js`

- [ ] Create `src/modules/auction/` directory
- [ ] Create `src/modules/auction/auctionService.js`:

```js
// src/modules/auction/auctionService.js
import redis from '../../../config/redis.js';
import { getClient } from '../../../config/database.js';
import { AuctionModel } from '../../models/auction.js';
import { AuctionBidModel } from '../../models/auctionBid.js';
import { UserModel } from '../../models/user.js';

const LOCK_PREFIX  = 'auction:lock:';
const LOCK_TTL_MS  = 5000;

async function acquireLock(auctionId) {
  return (await redis.set(LOCK_PREFIX + auctionId, '1', 'NX', 'PX', LOCK_TTL_MS)) === 'OK';
}

async function releaseLock(auctionId) {
  await redis.del(LOCK_PREFIX + auctionId);
}

export async function placeBid({ telegramUser, auction, amount }) {
  const lockAcquired = await acquireLock(auction.id);
  if (!lockAcquired) return { success: false, reason: 'busy' };

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const user = await UserModel.upsertAndGetStatus({
      telegramId: telegramUser.id,
      username: telegramUser.username,
      firstName: telegramUser.first_name,
      lastName: telegramUser.last_name,
    });

    const updatedAuction = await AuctionModel.placeBid(
      { auctionId: auction.id, userId: user.id, amount },
      client
    );

    if (!updatedAuction) {
      await client.query('ROLLBACK');
      const minRequired = auction.current_bid != null
        ? parseFloat(auction.current_bid) + parseFloat(auction.min_increment)
        : parseFloat(auction.starting_bid);
      return { success: false, reason: 'invalid_bid', minRequired };
    }

    const bid = await AuctionBidModel.insert(
      { auctionId: auction.id, userId: user.id, amount },
      client
    );

    await client.query('COMMIT');
    return { success: true, bid, auction: updatedAuction, user };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await releaseLock(auction.id);
  }
}

// Called by cron every 60s
export async function runAuctionLifecycle(bot, adminTelegramId) {
  // Activate upcoming
  const activated = await AuctionModel.activateDue();
  for (const a of activated) {
    console.log(`[Auction] Activated: ${a.name} (#${a.id})`);
  }

  // End overdue
  const ended = await AuctionModel.endDue();
  for (const auction of ended) {
    await notifyAdminAuctionEnded(bot, adminTelegramId, auction);
  }
}

async function notifyAdminAuctionEnded(bot, adminTelegramId, auction) {
  if (!auction.winner_user_id) {
    await bot.sendMessage(
      adminTelegramId,
      `🔔 Auction ended: *${auction.name}*\n\nNo bids were placed. No winner.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const winner = await UserModel.findByTelegramId(null); // need by internal id
  // Fetch by user_id (internal)
  const { rows } = await import('../../../config/database.js').then(m =>
    m.query('SELECT * FROM users WHERE id = $1', [auction.winner_user_id])
  );
  const w = rows[0];
  const handle = w ? (w.username ? `@${w.username}` : (w.first_name || `ID:${w.telegram_id}`)) : 'Unknown';

  await bot.sendMessage(
    adminTelegramId,
    `🏆 *Auction Ended: ${auction.name}*\n\n` +
    `Winner: ${handle}\n` +
    `Winning bid: *$${parseFloat(auction.winner_bid).toFixed(2)}*\n\n` +
    `Use \`/invoice ${handle}\` to generate their invoice.`,
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] Fix the `notifyAdminAuctionEnded` function — the inline dynamic import pattern is messy. Replace with a static import at the top:

```js
// src/modules/auction/auctionService.js
import redis from '../../../config/redis.js';
import { getClient, query } from '../../../config/database.js';
import { AuctionModel } from '../../models/auction.js';
import { AuctionBidModel } from '../../models/auctionBid.js';
import { UserModel } from '../../models/user.js';
```

And replace the `notifyAdminAuctionEnded` winner lookup:

```js
async function notifyAdminAuctionEnded(bot, adminTelegramId, auction) {
  if (!auction.winner_user_id) {
    await bot.sendMessage(
      adminTelegramId,
      `🔔 Auction ended: *${auction.name}*\n\nNo bids placed. No winner.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [auction.winner_user_id]);
  const w = rows[0];
  const handle = w
    ? (w.username ? `@${w.username}` : (w.first_name || `ID:${w.telegram_id}`))
    : 'Unknown';

  await bot.sendMessage(
    adminTelegramId,
    `🏆 *Auction Ended: ${auction.name}*\n\n` +
    `Winner: ${handle}\n` +
    `Winning bid: *$${parseFloat(auction.winner_bid).toFixed(2)}*\n\n` +
    `Use \`/invoice ${handle}\` to generate their invoice.`,
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] Create `src/modules/auction/auctionWizard.js`:

```js
// src/modules/auction/auctionWizard.js
import { Scenes } from 'telegraf';
import { AuctionModel } from '../../models/auction.js';

export const NEW_AUCTION_WIZARD_ID = 'new-auction-wizard';

function parseSGTDateTime(str) {
  // Expects "DD/MM/YYYY HH:MM" or "DD/MM HH:MM" (current year assumed)
  const full  = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  const short = str.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);

  let day, month, year, hour, minute;

  if (full) {
    [, day, month, year, hour, minute] = full;
  } else if (short) {
    [, day, month, hour, minute] = short;
    year = new Date().getFullYear();
  } else {
    return null;
  }

  // Build date in SGT (UTC+8)
  const iso = `${year}-${month}-${day}T${hour}:${minute}:00+08:00`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

export const newAuctionWizard = new Scenes.WizardScene(
  NEW_AUCTION_WIZARD_ID,

  // Step 0: entered with { messageId } in wizard state
  async (ctx) => {
    await ctx.reply(
      '🔨 *New Auction Setup*\n\nWhat is the item name?\n\n_Type /cancel at any time._',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 1: name → ask description
  async (ctx) => {
    if (!ctx.message?.text) return;
    const name = ctx.message.text.trim();
    if (name.length < 2) return ctx.reply('Name is too short. Try again:');
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

  // Step 5: end time → show confirmation
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

  // Step 6: confirm → create auction
  async (ctx) => {
    if (!ctx.message?.text) return;
    const answer = ctx.message.text.trim().toLowerCase();

    if (answer !== 'yes') {
      await ctx.reply('❌ Cancelled. No auction was created.');
      return ctx.scene.leave();
    }

    const { messageId, name, description, startingBid, minIncrement, endTime } = ctx.wizard.state;

    const existing = await AuctionModel.findByMessageId(messageId);
    if (existing) {
      await ctx.reply(`⚠️ Post #${messageId} already has an auction: *${existing.name}*.`, { parse_mode: 'Markdown' });
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
```

- [ ] Create `src/handlers/auctionHandler.js`:

```js
// src/handlers/auctionHandler.js
import { AuctionModel } from '../models/auction.js';
import { placeBid } from '../modules/auction/auctionService.js';

const BID_REGEX = /^bid\s+(\d+(?:\.\d{1,2})?)$/i;
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function handleBid(ctx) {
  const text = ctx.message?.text?.trim() || '';
  const match = text.match(BID_REGEX);
  if (!match) return; // not a bid message

  const amount = parseFloat(match[1]);
  const channelPostId = ctx.channelPostId;

  const auction = await AuctionModel.findByMessageId(channelPostId);
  if (!auction) return;

  if (auction.status !== 'active') {
    return ctx.reply(
      auction.status === 'ended'
        ? `🔒 This auction has ended.`
        : `⚠️ This auction is not currently active.`,
      { reply_to_message_id: ctx.message.message_id }
    );
  }

  let result = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    result = await placeBid({ telegramUser: ctx.from, auction, amount });
    if (result.reason !== 'busy') break;
    await sleep(RETRY_DELAY);
  }

  if (!result || result.reason === 'busy') {
    return ctx.reply('⏳ High traffic — try again in a moment.', {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  if (result.success) {
    const { auction: updated } = result;
    const endStr = new Date(updated.end_time).toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit',
    });
    return ctx.reply(
      `🏆 Bid of *$${amount.toFixed(2)}* accepted!\n` +
      `You're currently leading. Auction closes at ${endStr} SGT.`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }

  if (result.reason === 'invalid_bid') {
    return ctx.reply(
      `❌ Minimum bid is *$${result.minRequired.toFixed(2)}*. Try again.`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }
}
```

- [ ] Commit: `git add src/modules/auction/ src/models/auction.js src/models/auctionBid.js src/handlers/auctionHandler.js && git commit -m "feat: auction service, wizard, and bid handler"`

---

## Task 11: Auction admin commands

**Files:** `src/handlers/adminHandler.js`

- [ ] Add these exports to adminHandler.js:

```js
export async function handleAuctionBids(ctx) {
  const args = ctx.message.text.split(' ');
  const rawMsgId = args[1];
  if (!rawMsgId) return ctx.reply('Usage: `/auctionbids <post_id>`', { parse_mode: 'Markdown' });

  const msgId = parseInt(rawMsgId, 10);
  const auction = await AuctionModel.findByMessageId(msgId);
  if (!auction) return ctx.reply(`❌ No auction found for post #${msgId}.`);

  const bids = await AuctionBidModel.listForAuction(auction.id);
  if (bids.length === 0) return ctx.reply(`No bids yet for *${auction.name}*.`, { parse_mode: 'Markdown' });

  const lines = bids.map((b, i) => {
    const handle = b.username ? `@${b.username}` : (b.first_name || `ID:${b.telegram_id}`);
    const crown  = b.is_winning ? ' 👑' : '';
    return `  ${i + 1}. ${handle} — $${parseFloat(b.amount).toFixed(2)}${crown}`;
  });

  return ctx.reply(
    `🔨 *Bids for ${auction.name}*\n` +
    `Current: $${auction.current_bid ? parseFloat(auction.current_bid).toFixed(2) : '—'}\n\n` +
    lines.join('\n'),
    { parse_mode: 'Markdown' }
  );
}

export async function handleEndAuction(ctx) {
  const args = ctx.message.text.split(' ');
  const rawMsgId = args[1];
  if (!rawMsgId) return ctx.reply('Usage: `/endauction <post_id>`', { parse_mode: 'Markdown' });

  const msgId = parseInt(rawMsgId, 10);
  const auction = await AuctionModel.findByMessageId(msgId);
  if (!auction) return ctx.reply(`❌ No auction found for post #${msgId}.`);
  if (auction.status !== 'active') return ctx.reply(`❌ Auction is not active (status: ${auction.status}).`);

  await AuctionModel.forceEnd(auction.id);
  return ctx.reply(`✅ Auction *${auction.name}* force-ended. Lifecycle cron will close it within 60s.`, { parse_mode: 'Markdown' });
}

export async function handleCancelAuction(ctx) {
  const args = ctx.message.text.split(' ');
  const rawMsgId = args[1];
  if (!rawMsgId) return ctx.reply('Usage: `/cancelauction <post_id>`', { parse_mode: 'Markdown' });

  const msgId = parseInt(rawMsgId, 10);
  const auction = await AuctionModel.findByMessageId(msgId);
  if (!auction) return ctx.reply(`❌ No auction found for post #${msgId}.`);

  const cancelled = await AuctionModel.cancel(auction.id);
  if (!cancelled) return ctx.reply(`❌ Could not cancel auction (status: ${auction.status}).`);

  return ctx.reply(`✅ Auction *${auction.name}* cancelled.`, { parse_mode: 'Markdown' });
}
```

- [ ] Add imports at top: `import { AuctionModel } from '../models/auction.js'; import { AuctionBidModel } from '../models/auctionBid.js';`

- [ ] Commit: `git add src/handlers/adminHandler.js && git commit -m "feat: auction admin commands"`

---

## Task 12: Giveaway model + service

**Files:** `src/models/giveaway.js`, `src/modules/giveaway/giveawayService.js`

- [ ] Create `src/models/giveaway.js`:

```js
// src/models/giveaway.js
import { query, getClient } from '../../config/database.js';

export const GiveawayModel = {

  async createPool({ title, prizeDescription, notes, createdBy }) {
    const { rows } = await query(
      `INSERT INTO giveaway_pools (title, prize_description, notes, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, prizeDescription || null, notes || null, createdBy]
    );
    return rows[0];
  },

  async getActivePool() {
    const { rows } = await query(
      `SELECT * FROM giveaway_pools WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );
    return rows[0] || null;
  },

  async addEntries({ poolId, entries }) {
    // entries = [{ userId, invoiceId, claimId }]
    if (!entries.length) return [];
    const placeholders = entries.map((_, i) =>
      `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`
    ).join(', ');
    const values = [poolId, ...entries.flatMap(e => [e.userId, e.invoiceId, e.claimId])];
    const { rows } = await query(
      `INSERT INTO giveaway_entries (pool_id, user_id, invoice_id, claim_id)
       VALUES ${placeholders}
       ON CONFLICT (pool_id, claim_id) DO NOTHING
       RETURNING *`,
      values
    );
    return rows;
  },

  async getPoolStats(poolId) {
    const { rows } = await query(
      `SELECT
         COUNT(*) AS total_entries,
         COUNT(DISTINCT user_id) AS unique_users
       FROM giveaway_entries
       WHERE pool_id = $1`,
      [poolId]
    );
    return rows[0];
  },

  async getTopContributors(poolId) {
    const { rows } = await query(
      `SELECT u.username, u.first_name, u.telegram_id,
              COUNT(ge.id) AS entries
       FROM giveaway_entries ge
       JOIN users u ON u.id = ge.user_id
       WHERE ge.pool_id = $1
       GROUP BY u.id
       ORDER BY entries DESC
       LIMIT 10`,
      [poolId]
    );
    return rows;
  },

  async drawWinner({ poolId, drawnBy }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows: entries } = await client.query(
        `SELECT * FROM giveaway_entries WHERE pool_id = $1`,
        [poolId]
      );

      if (!entries.length) {
        await client.query('ROLLBACK');
        return null;
      }

      const { randomInt } = await import('node:crypto');
      const winner = entries[randomInt(0, entries.length)];

      await client.query(
        `INSERT INTO giveaway_draws (pool_id, winner_user_id, winning_entry_id, drawn_by)
         VALUES ($1, $2, $3, $4)`,
        [poolId, winner.user_id, winner.id, drawnBy]
      );

      await client.query(
        `UPDATE giveaway_pools SET status = 'drawn' WHERE id = $1`,
        [poolId]
      );

      await client.query('COMMIT');
      return winner;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async cancelPool(poolId) {
    const { rows } = await query(
      `UPDATE giveaway_pools SET status = 'cancelled'
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [poolId]
    );
    return rows[0] || null;
  },
};
```

- [ ] Create `src/modules/giveaway/` directory
- [ ] Create `src/modules/giveaway/giveawayService.js`:

```js
// src/modules/giveaway/giveawayService.js
import { GiveawayModel } from '../../models/giveaway.js';

export const GiveawayService = {

  async addEntries({ pool, invoiceId, claims, userId }) {
    const entries = claims.map(c => ({
      userId,
      invoiceId,
      claimId: c.claim_id,
    }));
    return GiveawayModel.addEntries({ poolId: pool.id, entries });
  },
};
```

- [ ] Commit: `git add src/models/giveaway.js src/modules/giveaway/ && git commit -m "feat: GiveawayModel and GiveawayService"`

---

## Task 13: Giveaway admin commands

**Files:** `src/handlers/adminHandler.js`

- [ ] Add giveaway wizard scene for `/newgiveaway`. Since giveaway creation is simple (3 fields), implement as a WizardScene in `src/scenes/newGiveawayWizard.js`:

```js
// src/scenes/newGiveawayWizard.js
import { Scenes } from 'telegraf';
import { GiveawayModel } from '../models/giveaway.js';

export const NEW_GIVEAWAY_WIZARD_ID = 'new-giveaway-wizard';

export const newGiveawayWizard = new Scenes.WizardScene(
  NEW_GIVEAWAY_WIZARD_ID,

  async (ctx) => {
    const existing = await GiveawayModel.getActivePool();
    if (existing) {
      await ctx.reply(
        `⚠️ There's already an active pool: *${existing.title}*\n\nUse /cleargiveaway to cancel it first.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }
    await ctx.reply('🎁 *New Giveaway*\n\nWhat is the giveaway title?\n\n_/cancel to stop._', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  async (ctx) => {
    if (!ctx.message?.text) return;
    const title = ctx.message.text.trim();
    if (title.length < 3) return ctx.reply('Title too short. Try again:');
    ctx.wizard.state.title = title;
    await ctx.reply('Prize description? (optional — send `-` to skip)');
    return ctx.wizard.next();
  },

  async (ctx) => {
    if (!ctx.message?.text) return;
    const desc = ctx.message.text.trim();
    ctx.wizard.state.prizeDescription = desc === '-' ? null : desc;
    await ctx.reply('Any notes? (optional — send `-` to skip)');
    return ctx.wizard.next();
  },

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

  async (ctx) => {
    if (!ctx.message?.text) return;
    if (ctx.message.text.trim().toLowerCase() !== 'yes') {
      await ctx.reply('❌ Cancelled.');
      return ctx.scene.leave();
    }
    const { title, prizeDescription, notes } = ctx.wizard.state;
    const pool = await GiveawayModel.createPool({ title, prizeDescription, notes, createdBy: ctx.from.id });
    await ctx.reply(`✅ Giveaway pool *${pool.title}* is now active!\n\nEntries are added automatically when invoices are paid.`, { parse_mode: 'Markdown' });
    return ctx.scene.leave();
  }
);

newGiveawayWizard.command('cancel', async (ctx) => { await ctx.reply('❌ Cancelled.'); return ctx.scene.leave(); });
```

- [ ] Add giveaway command handlers to adminHandler.js:

```js
export async function handleDrawGiveaway(ctx) {
  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active giveaway pool. Start one with /newgiveaway.');

  const stats = await GiveawayModel.getPoolStats(pool.id);
  if (parseInt(stats.total_entries) === 0) {
    return ctx.reply(`❌ Pool *${pool.title}* has no entries yet.`, { parse_mode: 'Markdown' });
  }

  const winnerEntry = await GiveawayModel.drawWinner({ poolId: pool.id, drawnBy: ctx.from.id });
  if (!winnerEntry) return ctx.reply('❌ Could not draw winner — pool may be empty.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [winnerEntry.user_id]);
  const w = rows[0];
  const handle = w ? (w.username ? `@${w.username}` : (w.first_name || `ID:${w.telegram_id}`)) : 'Unknown';

  return ctx.reply(
    `🎉 *Winner Drawn!*\n\n` +
    `*${pool.title}*\n` +
    `Prize: ${pool.prize_description || '_not specified_'}\n\n` +
    `Winner: *${handle}*\n` +
    `Drawn from ${stats.total_entries} entries across ${stats.unique_users} participants.\n\n` +
    `Pool has been closed. Start a new one with /newgiveaway.`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleGiveawayStats(ctx) {
  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active giveaway pool.');

  const stats = await GiveawayModel.getPoolStats(pool.id);
  const top   = await GiveawayModel.getTopContributors(pool.id);

  const topLines = top.map((u, i) => {
    const handle = u.username ? `@${u.username}` : (u.first_name || `ID:${u.telegram_id}`);
    return `  ${i + 1}. ${handle} — ${u.entries} entr${u.entries === '1' ? 'y' : 'ies'}`;
  });

  return ctx.reply(
    `🎁 *${pool.title}*\n` +
    `${pool.prize_description ? `Prize: ${pool.prize_description}\n` : ''}` +
    `\nTotal entries: *${stats.total_entries}*\n` +
    `Unique participants: *${stats.unique_users}*\n\n` +
    (topLines.length ? `*Top Contributors:*\n${topLines.join('\n')}` : '_No entries yet._'),
    { parse_mode: 'Markdown' }
  );
}

export async function handleClearGiveaway(ctx) {
  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active giveaway pool to clear.');

  return ctx.reply(
    `⚠️ Cancel giveaway pool *${pool.title}* without drawing a winner?\n\nReply \`CONFIRM\` to proceed.`,
    { parse_mode: 'Markdown' }
  );
}

const PENDING_CLEAR_GIVEAWAY = new Map();

export async function handleClearGiveawayConfirm(ctx) {
  const text = ctx.message?.text?.trim() || '';
  if (text !== 'CONFIRM') return;

  const pool = await GiveawayModel.getActivePool();
  if (!pool) return ctx.reply('❌ No active pool to clear.');

  const cancelled = await GiveawayModel.cancelPool(pool.id);
  if (!cancelled) return ctx.reply('❌ Could not cancel pool.');

  return ctx.reply(`✅ Giveaway pool *${pool.title}* cancelled. History preserved.`, { parse_mode: 'Markdown' });
}
```

- [ ] Add `import { GiveawayModel } from '../models/giveaway.js';` to adminHandler.js imports.

- [ ] Commit: `git add src/scenes/newGiveawayWizard.js src/handlers/adminHandler.js && git commit -m "feat: giveaway commands and wizard"`

---

## Task 14: Scheduled post model + service

**Files:** `src/models/scheduledPost.js`, `src/modules/scheduler/schedulerService.js`, `src/modules/scheduler/scheduleWizard.js`

- [ ] Create `src/models/scheduledPost.js`:

```js
// src/models/scheduledPost.js
import { query } from '../../config/database.js';

export const ScheduledPostModel = {

  async create({ type, content, productId, auctionId, scheduledAt, createdBy }) {
    const { rows } = await query(
      `INSERT INTO scheduled_posts
         (type, content, product_id, auction_id, scheduled_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [type, content || null, productId || null, auctionId || null, scheduledAt, createdBy]
    );
    return rows[0];
  },

  async listPending() {
    const { rows } = await query(
      `SELECT sp.*,
              p.name AS product_name,
              a.name AS auction_name
       FROM scheduled_posts sp
       LEFT JOIN products p ON p.id = sp.product_id
       LEFT JOIN auctions a ON a.id = sp.auction_id
       WHERE sp.status = 'pending'
       ORDER BY sp.scheduled_at ASC`
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT sp.*, p.name AS product_name, a.name AS auction_name
       FROM scheduled_posts sp
       LEFT JOIN products p ON p.id = sp.product_id
       LEFT JOIN auctions a ON a.id = sp.auction_id
       WHERE sp.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async markSent(id) {
    await query(
      `UPDATE scheduled_posts SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  async markFailed(id, reason) {
    await query(
      `UPDATE scheduled_posts SET status = 'failed', fail_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, reason]
    );
  },

  async cancel(id, reason) {
    const { rows } = await query(
      `UPDATE scheduled_posts SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, reason || null]
    );
    return rows[0] || null;
  },
};
```

- [ ] Create `src/modules/scheduler/` directory
- [ ] Create `src/modules/scheduler/schedulerService.js`:

```js
// src/modules/scheduler/schedulerService.js
import cron from 'node-cron';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { ProductModel } from '../../models/product.js';
import { AuctionModel } from '../../models/auction.js';

const RATE_DELAY_MS = 100; // Telegram rate limit buffer between sends

function formatSGT(date) {
  return new Date(date).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function buildPostContent(post) {
  if (post.type === 'free_form') return post.content;

  if (post.type === 'product_listing') {
    return `📦 *${post.product_name}*\n\nComment \`claim\` below to reserve yours!`;
  }

  if (post.type === 'auction_listing') {
    return `🔨 *Auction: ${post.auction_name}*\n\nComment \`bid [amount]\` to place a bid!`;
  }

  return post.content || '';
}

const activeTimeouts = new Map(); // postId → timeoutHandle

export function schedulePost(bot, post) {
  const msUntilPost = new Date(post.scheduled_at) - Date.now();
  if (msUntilPost <= 0) {
    // Past-due: fire immediately
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

  try {
    await bot.telegram.sendMessage(process.env.CHANNEL_ID, content, { parse_mode: 'Markdown' });
    await ScheduledPostModel.markSent(post.id);
    console.log(`[Scheduler] Sent post #${post.id} (${post.type})`);
  } catch (err) {
    console.error(`[Scheduler] Failed post #${post.id}:`, err.message);
    await ScheduledPostModel.markFailed(post.id, err.message);
  }
}

// Called at boot — loads all pending posts from DB and schedules them
export async function init(bot) {
  const pending = await ScheduledPostModel.listPending();
  console.log(`[Scheduler] Rehydrating ${pending.length} pending post(s)`);

  for (const post of pending) {
    schedulePost(bot, post);
    await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }

  // Auction lifecycle cron — every 60 seconds
  const adminId = parseInt((process.env.ADMIN_IDS || '').split(',')[0], 10);
  cron.schedule('* * * * *', async () => {
    const { runAuctionLifecycle } = await import('../auction/auctionService.js');
    await runAuctionLifecycle(bot.telegram, adminId).catch(err =>
      console.error('[Cron] Auction lifecycle error:', err.message)
    );
  });

  console.log('[Scheduler] Cron started');
}
```

- [ ] Create `src/modules/scheduler/scheduleWizard.js`:

```js
// src/modules/scheduler/scheduleWizard.js
import { Scenes, Markup } from 'telegraf';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { schedulePost } from './schedulerService.js';

export const SCHEDULE_WIZARD_ID = 'schedule-post-wizard';

function parseSGTDateTime(str) {
  const full  = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  const short = str.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  let day, month, year, hour, minute;
  if (full) [, day, month, year, hour, minute] = full;
  else if (short) { [, day, month, hour, minute] = short; year = new Date().getFullYear(); }
  else return null;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  return isNaN(date.getTime()) ? null : date;
}

let _bot = null; // set during init

export function initScheduleWizard(bot) { _bot = bot; }

export const scheduleWizard = new Scenes.WizardScene(
  SCHEDULE_WIZARD_ID,

  // Step 0: ask type
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

  // Step 1: handle type selection
  async (ctx) => {
    if (!ctx.message?.text) return;
    const t = ctx.message.text;
    if (t.includes('Free-form') || t === 'free_form') ctx.wizard.state.type = 'free_form';
    else if (t.includes('Product')   || t === 'product_listing')  ctx.wizard.state.type = 'product_listing';
    else if (t.includes('Auction')   || t === 'auction_listing')  ctx.wizard.state.type = 'auction_listing';
    else return ctx.reply('Please select one of the options.');

    if (ctx.wizard.state.type === 'free_form') {
      await ctx.reply('Type your post content:', Markup.removeKeyboard());
      return ctx.wizard.next();
    }
    if (ctx.wizard.state.type === 'product_listing') {
      await ctx.reply('Enter the product post ID (message ID from the channel):', Markup.removeKeyboard());
      return ctx.wizard.next();
    }
    if (ctx.wizard.state.type === 'auction_listing') {
      await ctx.reply('Enter the auction post ID:', Markup.removeKeyboard());
      return ctx.wizard.next();
    }
  },

  // Step 2: get content / post ID
  async (ctx) => {
    if (!ctx.message?.text) return;
    const type = ctx.wizard.state.type;

    if (type === 'free_form') {
      ctx.wizard.state.content = ctx.message.text;
    } else {
      const id = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(id)) return ctx.reply('❌ Invalid ID. Enter a number:');
      if (type === 'product_listing') ctx.wizard.state.postId = id;
      else ctx.wizard.state.postId = id;
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

    const typeLabel = { free_form: 'Free-form', product_listing: 'Product listing', auction_listing: 'Auction listing' }[ctx.wizard.state.type];
    const whenStr = when.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    const preview = ctx.wizard.state.content
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
      content: type === 'free_form' ? content : null,
      productId:  type === 'product_listing'  ? postId : null,
      auctionId:  type === 'auction_listing'   ? postId : null,
      scheduledAt,
      createdBy: ctx.from.id,
    });

    if (_bot) schedulePost(_bot, post);

    const whenStr = scheduledAt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    await ctx.reply(`✅ Post #${post.id} scheduled for *${whenStr} SGT*.`, { parse_mode: 'Markdown' });
    return ctx.scene.leave();
  }
);

scheduleWizard.command('cancel', async (ctx) => { await ctx.reply('❌ Cancelled.'); return ctx.scene.leave(); });
```

- [ ] Commit: `git add src/models/scheduledPost.js src/modules/scheduler/ && git commit -m "feat: scheduler service, model, and wizard"`

---

## Task 15: Scheduler admin commands

**Files:** `src/handlers/adminHandler.js`

- [ ] Add to adminHandler.js:

```js
export async function handleListScheduled(ctx) {
  const posts = await ScheduledPostModel.listPending();
  if (posts.length === 0) return ctx.reply('No scheduled posts pending.');

  const typeEmoji = { free_form: '📝', product_listing: '📦', auction_listing: '🔨' };
  const lines = posts.map(p => {
    const emoji = typeEmoji[p.type] || '📅';
    const label = p.product_name || p.auction_name || p.content?.slice(0, 30) || '—';
    const when = new Date(p.scheduled_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
    return `${emoji} #${p.id} — ${label} — ${when} SGT`;
  });

  return ctx.reply(`📅 *Scheduled Posts*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

export async function handleDeleteScheduled(ctx) {
  const args = ctx.message.text.split(' ');
  const id = parseInt(args[1], 10);
  if (isNaN(id)) return ctx.reply('Usage: `/deletescheduled <id>`', { parse_mode: 'Markdown' });

  const { cancelScheduledPost } = await import('../modules/scheduler/schedulerService.js');
  cancelScheduledPost(id);

  const cancelled = await ScheduledPostModel.cancel(id, 'Cancelled by admin');
  if (!cancelled) return ctx.reply(`❌ Post #${id} not found or already sent/cancelled.`);

  return ctx.reply(`✅ Scheduled post #${id} cancelled.`);
}
```

- [ ] Add `import { ScheduledPostModel } from '../models/scheduledPost.js';` to adminHandler.js imports.

- [ ] Commit: `git add src/handlers/adminHandler.js && git commit -m "feat: scheduler admin commands"`

---

## Task 16: Update claimHandler — registration gate + auction routing

**Files:** `src/handlers/claimHandler.js`

- [ ] Replace entire file:

```js
// src/handlers/claimHandler.js
import { ProductModel } from '../models/product.js';
import { AuctionModel } from '../models/auction.js';
import { attemptClaim } from '../services/stockService.js';
import { handleBid } from './auctionHandler.js';
import { query } from '../../config/database.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function handleClaim(ctx) {
  const text = ctx.message?.text?.toLowerCase() || '';

  // Check post_registry to determine type
  const channelPostId = ctx.channelPostId;
  const { rows: regRows } = await query(
    'SELECT post_type FROM post_registry WHERE telegram_message_id = $1',
    [channelPostId]
  );

  const postType = regRows[0]?.post_type;

  // Route auction bids
  if (postType === 'auction') {
    if (/^bid\s+\d+(?:\.\d{1,2})?$/i.test(text.trim())) {
      return handleBid(ctx);
    }
    return; // non-bid message on auction post — ignore
  }

  // Fixed-price claim flow
  if (!text.includes('claim')) return;

  const product = await ProductModel.findByMessageId(channelPostId);
  if (!product) return;

  if (product.status === 'sold_out') {
    return ctx.reply(soldOutMessage(product), { reply_to_message_id: ctx.message.message_id });
  }
  if (product.status === 'cancelled') {
    return ctx.reply('❌ This listing has been cancelled.', { reply_to_message_id: ctx.message.message_id });
  }

  let result = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    result = await attemptClaim({ telegramUser: ctx.from, product });
    if (result.reason !== 'busy') break;
    await sleep(RETRY_DELAY_MS);
  }

  if (!result || result.reason === 'busy') {
    return ctx.reply('⏳ Processing a lot of claims — please try again in a moment.', {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  if (result.success) {
    const { product: updatedProduct } = result;
    const remaining = updatedProduct.quantity_remaining;
    return ctx.reply(
      [
        `✅ Claimed! *${product.name}* is yours, ${formatName(ctx.from)}.`,
        ``,
        `You'll hear from the seller soon.`,
        remaining > 0
          ? `_(${remaining} unit${remaining === 1 ? '' : 's'} remaining)_`
          : `_(Last one! 🎉)_`,
      ].join('\n'),
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }

  switch (result.reason) {
    case 'sold_out':
      return ctx.reply(soldOutMessage(product), { reply_to_message_id: ctx.message.message_id });
    case 'duplicate':
      return ctx.reply(
        `You've already claimed *${product.name}*! The seller will be in touch.`,
        { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
      );
    default:
      console.error('[claimHandler] Unexpected result:', result);
      return ctx.reply('Something went wrong — please try again.', { reply_to_message_id: ctx.message.message_id });
  }
}

function soldOutMessage(product) { return `🔴 *${product.name}* is sold out. Better luck next time!`; }
function formatName(user) { return user.first_name ? `@${user.username || user.first_name}` : 'friend'; }
```

- [ ] Commit: `git add src/handlers/claimHandler.js && git commit -m "feat: claimHandler with post_registry routing and auction bid dispatch"`

---

## Task 17: Update newProductWizard — write to post_registry

**Files:** `src/scenes/newProductWizard.js`

- [ ] Add `import { query } from '../../config/database.js';` at top of newProductWizard.js.

- [ ] In Step 4 (the final confirm step), after `ProductModel.create(...)`, add:

```js
await query(
  `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
   VALUES ($1, 'product', $2) ON CONFLICT DO NOTHING`,
  [product.telegram_message_id, product.id]
);
```

- [ ] Also in `handleNewProduct` in `adminHandler.js`, add the same post_registry insert after `ProductModel.create()`. (Already noted in Task 8 — verify it's there.)

- [ ] Commit: `git add src/scenes/newProductWizard.js && git commit -m "feat: newProductWizard writes to post_registry"`

---

## Task 18: Update /start and forward trigger in index.js + callback_query handler

**Files:** `src/index.js`

- [ ] Replace entire `src/index.js`:

```js
// src/index.js
import 'dotenv/config';
import { Telegraf, session, Scenes } from 'telegraf';
import express from 'express';

import { commentOnly, adminOnly, isAdmin, registrationRequired } from './middleware/guards.js';
import { handleClaim }                from './handlers/claimHandler.js';
import {
  handleNewProduct, handleStock, handleViewClaims,
  handleSendInvoice, handleSendAllInvoices, handlePending,
  handleAdminStart, handleHelp,
  handleConfirmPaid, handleDeleteInvoice, handleDeleteInvoiceConfirm,
  handleInvoiceHistory, cancelInvoiceById, confirmPaidById,
  handleAuctionBids, handleEndAuction, handleCancelAuction,
  handleDrawGiveaway, handleGiveawayStats, handleClearGiveaway, handleClearGiveawayConfirm,
  handleListScheduled, handleDeleteScheduled,
} from './handlers/adminHandler.js';
import redis from '../config/redis.js';
import { newProductWizard, NEW_PRODUCT_WIZARD_ID } from './scenes/newProductWizard.js';
import { newAuctionWizard, NEW_AUCTION_WIZARD_ID }  from './modules/auction/auctionWizard.js';
import { newGiveawayWizard, NEW_GIVEAWAY_WIZARD_ID } from './scenes/newGiveawayWizard.js';
import { scheduleWizard, SCHEDULE_WIZARD_ID, initScheduleWizard } from './modules/scheduler/scheduleWizard.js';
import { handleStartForBuyer, handleContactShare } from './modules/registration/registrationService.js';
import { init as initScheduler } from './modules/scheduler/schedulerService.js';
import { InvoiceModel } from './models/invoice.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[Bot] Error for ${ctx.updateType}:`, err.message, err.stack);
});

bot.use(session());
const stage = new Scenes.Stage([
  newProductWizard,
  newAuctionWizard,
  newGiveawayWizard,
  scheduleWizard,
]);
bot.use(stage.middleware());

// ── Admin commands ────────────────────────────────────────────────
bot.command('cancel',         adminOnly, (ctx) => ctx.reply('Nothing to cancel.'));
bot.command('newproduct',     adminOnly, handleNewProduct);
bot.command('stock',          adminOnly, handleStock);
bot.command('claims',         adminOnly, handleViewClaims);
bot.command('invoice',        adminOnly, handleSendInvoice);
bot.command('invoiceall',     adminOnly, handleSendAllInvoices);
bot.command('pending',        adminOnly, handlePending);
bot.command('invoicehistory', adminOnly, handleInvoiceHistory);
bot.command('confirmpaid',    adminOnly, handleConfirmPaid);
bot.command('deleteinvoice',  adminOnly, handleDeleteInvoice);
bot.command('createauction',  adminOnly, (ctx) => ctx.scene.enter(NEW_AUCTION_WIZARD_ID));
bot.command('auctionbids',    adminOnly, handleAuctionBids);
bot.command('endauction',     adminOnly, handleEndAuction);
bot.command('cancelauction',  adminOnly, handleCancelAuction);
bot.command('newgiveaway',    adminOnly, (ctx) => ctx.scene.enter(NEW_GIVEAWAY_WIZARD_ID));
bot.command('drawgiveaway',   adminOnly, handleDrawGiveaway);
bot.command('giveawaystats',  adminOnly, handleGiveawayStats);
bot.command('cleargiveaway',  adminOnly, handleClearGiveaway);
bot.command('schedulepost',   adminOnly, (ctx) => ctx.scene.enter(SCHEDULE_WIZARD_ID));
bot.command('listscheduled',  adminOnly, handleListScheduled);
bot.command('deletescheduled',adminOnly, handleDeleteScheduled);
bot.command('help',           adminOnly, handleHelp);

// ── /start ────────────────────────────────────────────────────────
bot.command('start', (ctx) => {
  if (isAdmin(ctx.from?.id)) return handleAdminStart(ctx);
  return handleStartForBuyer(ctx);
});

// ── Inline keyboard callbacks (invoice paid/cancel buttons) ───────
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data || '';

  if (data.startsWith('invoice:paid:')) {
    const invoiceId = parseInt(data.split(':')[2], 10);
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from?.id)) return;
    return confirmPaidById(ctx, invoiceId);
  }

  if (data.startsWith('invoice:cancel:')) {
    const invoiceId = parseInt(data.split(':')[2], 10);
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from?.id)) return;
    // Check invoice exists and is active before prompting
    const invoice = await InvoiceModel.findById(invoiceId);
    if (!invoice || invoice.status !== 'active') {
      return ctx.reply(`❌ Invoice #${invoiceId} is not active.`);
    }
    return cancelInvoiceById(ctx, invoiceId, 'Cancelled via button');
  }

  await ctx.answerCbQuery('Unknown action');
});

// ── Contact sharing (registration) ───────────────────────────────
bot.on('contact', (ctx) => {
  if (ctx.message?.chat?.type !== 'private') return;
  return handleContactShare(ctx);
});

// ── Forward channel post in admin DM → enter appropriate wizard ───
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  if (msg.chat.type !== 'private') return next();
  if (!isAdmin(ctx.from?.id)) return next();

  const fwdChatId = msg.forward_from_chat?.id;
  const isFromChannel = fwdChatId && String(fwdChatId) === String(process.env.CHANNEL_ID);
  if (!isFromChannel) return next();

  const messageId = msg.forward_from_message_id;
  if (!messageId) return ctx.reply('⚠️ Could not read the post ID from that forwarded message.');

  // Check if post is already registered
  const { query } = await import('../config/database.js');
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

  // Ask which type to create
  const { Markup } = await import('telegraf');
  return ctx.reply(
    '📬 What type of listing is this?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📦 Fixed-price Product', `forward:product:${messageId}`),
        Markup.button.callback('🔨 Auction', `forward:auction:${messageId}`),
      ],
    ])
  );
});

// ── Forward type selection callback ───────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data || '';

  if (data.startsWith('forward:product:')) {
    const messageId = parseInt(data.split(':')[2], 10);
    await ctx.answerCbQuery();
    return ctx.scene.enter(NEW_PRODUCT_WIZARD_ID, { messageId });
  }

  if (data.startsWith('forward:auction:')) {
    const messageId = parseInt(data.split(':')[2], 10);
    await ctx.answerCbQuery();
    return ctx.scene.enter(NEW_AUCTION_WIZARD_ID, { messageId });
  }
});

// ── Admin DM text (CONFIRM flows) ─────────────────────────────────
bot.on('message', async (ctx, next) => {
  if (ctx.message?.chat?.type !== 'private') return next();
  if (!isAdmin(ctx.from?.id)) return next();

  const text = ctx.message?.text?.trim() || '';

  if (text.toUpperCase().startsWith('CONFIRM')) {
    await handleDeleteInvoiceConfirm(ctx);
    await handleClearGiveawayConfirm(ctx);
    return;
  }

  return next();
});

// ── Group claim/bid handler ────────────────────────────────────────
bot.on('text', (ctx, next) => {
  if (ctx.message?.entities?.some(e => e.type === 'bot_command')) return;
  return next();
}, commentOnly, registrationRequired, handleClaim);

// ── Express + Webhook ─────────────────────────────────────────────
const app = express();
app.use(express.json());

const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res).catch((err) => {
    console.error('[Webhook] handleUpdate error:', err.message);
    res.sendStatus(500);
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

async function bootstrap() {
  await redis.connect();

  const me = await bot.telegram.getMe();
  bot.options.username = me.username;
  console.log('[Bot] Username:', me.username);

  initScheduleWizard(bot);
  await initScheduler(bot);

  const PORT = parseInt(process.env.PORT || '3000', 10);

  if (process.env.NODE_ENV === 'production') {
    const fullWebhookUrl = process.env.WEBHOOK_URL.replace(/\/+$/, '') + WEBHOOK_PATH;
    await bot.telegram.setWebhook(fullWebhookUrl, { secret_token: process.env.WEBHOOK_SECRET });
    console.log(`[Bot] Webhook set: ${fullWebhookUrl}`);
    app.listen(PORT, () => console.log(`[Bot] HTTP server listening on :${PORT}`));
  } else {
    console.log('[Bot] Starting in polling mode (development)');
    await bot.launch();
    console.log('[Bot] Polling started');
  }
}

process.once('SIGINT',  () => { bot.stop('SIGINT');  redis.disconnect(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); redis.disconnect(); });

bootstrap().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

export { bot };
```

**Note:** index.js has two `bot.on('callback_query', ...)` registrations — Telegraf processes them in order and stops at the first match. The forward type selection must be registered separately. Fix by merging both into one handler:

- [ ] Merge the two `callback_query` handlers into one:

```js
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});

  if (data.startsWith('invoice:paid:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const invoiceId = parseInt(data.split(':')[2], 10);
    return confirmPaidById(ctx, invoiceId);
  }

  if (data.startsWith('invoice:cancel:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const invoiceId = parseInt(data.split(':')[2], 10);
    const invoice = await InvoiceModel.findById(invoiceId);
    if (!invoice || invoice.status !== 'active') {
      return ctx.reply(`❌ Invoice #${invoiceId} is not active.`);
    }
    return cancelInvoiceById(ctx, invoiceId, 'Cancelled via button');
  }

  if (data.startsWith('forward:product:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const messageId = parseInt(data.split(':')[2], 10);
    return ctx.scene.enter(NEW_PRODUCT_WIZARD_ID, { messageId });
  }

  if (data.startsWith('forward:auction:')) {
    if (!isAdmin(ctx.from?.id)) return;
    const messageId = parseInt(data.split(':')[2], 10);
    return ctx.scene.enter(NEW_AUCTION_WIZARD_ID, { messageId });
  }
});
```

- [ ] Also fix the dynamic `import` inside the forward handler — replace with static import at top. Move `import { query } from '../config/database.js'` and `import { Markup } from 'telegraf'` to the static imports section (Markup is already exported from telegraf import; query needs to be added).

Final imports section for index.js:

```js
import 'dotenv/config';
import { Telegraf, session, Scenes, Markup } from 'telegraf';
import express from 'express';
import { query } from '../config/database.js';
import { commentOnly, adminOnly, isAdmin, registrationRequired } from './middleware/guards.js';
// ... rest of imports unchanged
```

- [ ] Commit: `git add src/index.js && git commit -m "feat: wire all modules into index.js"`

---

## Task 19: Update /help command

**Files:** `src/handlers/adminHandler.js`

- [ ] Replace `handleHelp`:

```js
export function handleHelp(ctx) {
  return ctx.reply(
    `📋 *Admin Command Reference*\n\n` +

    `*📦 Products*\n` +
    `Forward a channel post to this DM → choose Product or Auction\n` +
    `\`/newproduct <msg\\_id> <price> <qty> <name>\` — manual shortcut\n\n` +

    `*🔨 Auctions*\n` +
    `\`/createauction\` — start auction wizard\n` +
    `\`/auctionbids <post\\_id>\` — view all bids\n` +
    `\`/endauction <post\\_id>\` — force-end early\n` +
    `\`/cancelauction <post\\_id>\` — cancel auction\n\n` +

    `*📊 Status*\n` +
    `/stock — all products with stock levels\n` +
    `/pending — users with uninvoiced claims\n` +
    `/claims <post\\_id> — who claimed a product\n\n` +

    `*🧾 Invoices*\n` +
    `/invoice @username — generate invoice (shown here)\n` +
    `/invoiceall — generate for all pending users\n` +
    `/invoicehistory — paid & cancelled invoices\n` +
    `/confirmpaid <id> — mark invoice as paid\n` +
    `/deleteinvoice <id> — cancel invoice + restore stock\n\n` +

    `*🎁 Giveaway*\n` +
    `/newgiveaway — start a new pool\n` +
    `/drawgiveaway — draw winner & close pool\n` +
    `/giveawaystats — current pool stats\n` +
    `/cleargiveaway — cancel pool without drawing\n\n` +

    `*📅 Scheduling*\n` +
    `/schedulepost — schedule a channel post\n` +
    `/listscheduled — view pending scheduled posts\n` +
    `/deletescheduled <id> — cancel a scheduled post\n\n` +

    `*⚙️ Other*\n` +
    `/start — welcome & workflow guide\n` +
    `/cancel — exit any wizard\n` +
    `/help — this reference`,
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] Commit: `git add src/handlers/adminHandler.js && git commit -m "feat: update /help with all new commands"`

---

## Task 20: Syntax check + push

- [ ] Run syntax check on all modified/new files:

```bash
node --check src/index.js
node --check src/handlers/adminHandler.js
node --check src/handlers/claimHandler.js
node --check src/handlers/auctionHandler.js
node --check src/services/invoiceService.js
node --check src/services/stockService.js
node --check src/models/user.js
node --check src/models/invoice.js
node --check src/models/auction.js
node --check src/models/auctionBid.js
node --check src/models/giveaway.js
node --check src/models/scheduledPost.js
node --check src/modules/registration/registrationService.js
node --check src/modules/auction/auctionService.js
node --check src/modules/auction/auctionWizard.js
node --check src/modules/giveaway/giveawayService.js
node --check src/modules/scheduler/schedulerService.js
node --check src/modules/scheduler/scheduleWizard.js
node --check src/scenes/newGiveawayWizard.js
```

Expected: No output (no errors) for each file.

- [ ] Fix any syntax errors found.
- [ ] Push: `git push origin main`

---

## Schema to Run

Before deploying, run the migration on your Supabase database:

```bash
psql $DATABASE_URL < migrations/002_feature_expansion.sql
```

Or paste the contents directly in Supabase SQL Editor.

---

## Post-Deploy Test Checklist

**Registration:**
- New user sends /start → sees welcome + contact button
- User taps button, shares contact → "You're registered!"
- Registered user sends /start → sees returning welcome (no button)
- Unregistered user comments "claim" → gets registration link

**Invoice (admin):**
- /invoice @user → invoice text + [✅ Mark as Paid] [❌ Cancel Invoice] buttons appear in admin DM
- Tap ✅ → "Invoice #X marked as paid"
- Tap ❌ on already-paid invoice → "not active" error
- /invoiceall → generates for all pending users in admin DM
- /invoicehistory → shows paid/cancelled invoices
- /deleteinvoice <id> → prompts CONFIRM → on CONFIRM, cancels + restores stock
- After cancel, /pending shows those claims again

**Auctions:**
- Forward post → choose Auction → wizard creates auction
- /createauction → wizard creates auction
- User comments "bid 50" → bid accepted with confirmation
- Bid below minimum → "Minimum bid is $X" error
- Bid within 2 min of end → end time extends 2 min
- /auctionbids <post_id> → shows bid history with 👑 on winner

**Giveaway:**
- /newgiveaway → wizard creates pool
- /confirmpaid → giveaway entries created (check DB giveaway_entries)
- /giveawaystats → shows entry count + top contributors
- /drawgiveaway → announces winner, pool status = 'drawn'
- /newgiveaway while active pool exists → "already an active pool" error

**Scheduling:**
- /schedulepost → wizard, schedule 2 min in future → post fires in channel
- /listscheduled → shows pending posts
- /deletescheduled <id> → cancels
- Restart bot → pending posts rehydrated and still fire
