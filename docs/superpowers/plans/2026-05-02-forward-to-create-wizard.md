# Forward-to-Create Product Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins create product listings by forwarding a channel post to the bot's DM and answering three step-by-step prompts (name → price → quantity) instead of constructing a `/newproduct` command manually.

**Architecture:** A `Scenes.WizardScene` (Telegraf v4) manages the multi-step conversation. Forwarding a channel post to the bot DM auto-detects the `forward_from_message_id` and enters the wizard with it pre-loaded into wizard state. `session()` middleware (in-memory) persists state across messages. The existing `ProductModel.create()` handles the final write — no DB changes needed.

**Tech Stack:** Telegraf 4.16.3 (`Scenes.WizardScene`, `session`), Node.js ES modules, existing `ProductModel`

---

## Files

| Action  | Path                                 | Responsibility                                              |
|---------|--------------------------------------|-------------------------------------------------------------|
| Create  | `src/scenes/newProductWizard.js`     | All wizard steps, /cancel handler, command guard            |
| Modify  | `src/index.js` (lines 3, 18–24, 47) | session + stage middleware, forward trigger, scene import   |
| Modify  | `src/handlers/adminHandler.js`       | Update `/help` and `/start` tutorial text only              |

---

## Middleware Order (Critical)

The final registration order in `src/index.js` must be:

```
1. bot.use(session())            ← must be first
2. bot.use(stage.middleware())   ← must be before commands
3. bot.command(cancel, ...)      ← global cancel (outside wizard)
4. bot.command(newproduct, ...)  ← all existing admin commands
5. bot.command(start, ...)
6. bot.on('message', ...)        ← forward trigger (new)
7. bot.on('text', ...)           ← existing claim handler (unchanged)
```

When inside a wizard, the stage middleware intercepts updates and routes them to the active wizard step — global handlers in positions 3–7 are NOT reached. `/cancel` is therefore handled inside the scene itself (see Task 1). The global `bot.command('cancel')` only fires when no wizard is active.

---

## Task 1: Create the WizardScene

**Files:**
- Create: `src/scenes/newProductWizard.js`

- [ ] **Step 1: Create the file with all wizard steps**

```javascript
// src/scenes/newProductWizard.js
import { Scenes } from 'telegraf';
import { ProductModel } from '../models/product.js';

export const NEW_PRODUCT_WIZARD_ID = 'new-product-wizard';

export const newProductWizard = new Scenes.WizardScene(
  NEW_PRODUCT_WIZARD_ID,

  // ── Step 0: entered from forward trigger; messageId already in wizard state ──
  async (ctx) => {
    await ctx.reply(
      '📦 *New Product Setup*\n\n' +
      'What is the product name?\n\n' +
      '_Type /cancel at any time to stop._',
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // ── Step 1: receive name → ask price ──────────────────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const name = ctx.message.text.trim();
    if (name.length < 2) return ctx.reply('Name is too short. Try again:');
    ctx.wizard.state.name = name;
    await ctx.reply('Price per unit? (e.g. `12.50`)', { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  // ── Step 2: receive price → ask quantity ──────────────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const price = parseFloat(ctx.message.text.trim());
    if (isNaN(price) || price <= 0) {
      return ctx.reply('❌ Invalid price. Enter a positive number (e.g. `12.50`):', { parse_mode: 'Markdown' });
    }
    ctx.wizard.state.price = price;
    await ctx.reply('How many units are available?');
    return ctx.wizard.next();
  },

  // ── Step 3: receive quantity → show confirmation summary ──────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const quantity = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(quantity) || quantity <= 0) {
      return ctx.reply('❌ Enter a whole number greater than 0:');
    }
    ctx.wizard.state.quantity = quantity;
    const { name, price } = ctx.wizard.state;
    await ctx.reply(
      `*Confirm new product:*\n\n` +
      `Name: *${name}*\n` +
      `Price: *$${price.toFixed(2)}*\n` +
      `Stock: *${quantity} unit(s)*\n\n` +
      `Reply *yes* to create or *no* to cancel.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // ── Step 4: handle confirmation → create product ──────────────────────────
  async (ctx) => {
    if (!ctx.message?.text) return;
    const answer = ctx.message.text.trim().toLowerCase();

    if (answer !== 'yes') {
      await ctx.reply('❌ Cancelled. No product was created.');
      return ctx.scene.leave();
    }

    const { messageId, name, price, quantity } = ctx.wizard.state;

    const existing = await ProductModel.findByMessageId(messageId);
    if (existing) {
      await ctx.reply(
        `⚠️ Post #${messageId} is already registered as *${existing.name}*.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }

    const product = await ProductModel.create({ telegramMessageId: messageId, name, price, quantity });

    await ctx.reply(
      `✅ *Product created!*\n\n` +
      `*${product.name}*\n` +
      `Price: $${parseFloat(product.price).toFixed(2)}\n` +
      `Stock: ${product.quantity_total} unit(s)\n` +
      `Post ID: ${product.telegram_message_id}`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

// ── /cancel works at any wizard step ─────────────────────────────────────────
newProductWizard.command('cancel', async (ctx) => {
  await ctx.reply('❌ Cancelled.');
  return ctx.scene.leave();
});

// ── Any other /command while in wizard → redirect ────────────────────────────
newProductWizard.hears(/^\/\w+/, (ctx) =>
  ctx.reply('⚠️ Use /cancel to exit the product wizard first.')
);
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --input-type=module --eval "import('./src/scenes/newProductWizard.js').then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1); })"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/scenes/newProductWizard.js
git commit -m "feat: add newProductWizard WizardScene"
```

---

## Task 2: Wire the wizard into index.js

**Files:**
- Modify: `src/index.js`

There are four changes: (a) extend the Telegraf import, (b) add scene import, (c) register session + stage before commands, (d) add forward trigger before the text handler.

- [ ] **Step 1: Extend the Telegraf import (line 3)**

Replace:
```javascript
import { Telegraf } from 'telegraf';
```

With:
```javascript
import { Telegraf, session, Scenes } from 'telegraf';
```

- [ ] **Step 2: Add scene import after existing handler imports (after line 18)**

After:
```javascript
import redis from '../config/redis.js';
```

Add:
```javascript
import { newProductWizard, NEW_PRODUCT_WIZARD_ID } from './scenes/newProductWizard.js';
```

- [ ] **Step 3: Register session + stage immediately after bot.catch (after line 24)**

After:
```javascript
bot.catch((err, ctx) => {
  console.error(`[Bot] Error for ${ctx.updateType}:`, err.message, err.stack);
});
```

Add:
```javascript
bot.use(session());
const stage = new Scenes.Stage([newProductWizard]);
bot.use(stage.middleware());
```

- [ ] **Step 4: Add global /cancel command (after the stage, before other commands)**

After `bot.use(stage.middleware());`, add:
```javascript
bot.command('cancel', adminOnly, (ctx) =>
  ctx.reply('Nothing to cancel.')
);
```

This only fires when no wizard is active (stage swallows the command when inside a scene). It prevents an unhandled-command error if admin types `/cancel` outside the wizard.

- [ ] **Step 5: Add forward trigger (between bot.command('start') and bot.on('text'))**

After the `bot.command('start', ...)` block and before `bot.on('text', ...)`, add:

```javascript
// ── Forward channel post in admin DM → enter product wizard ──────────────────
bot.on('message', adminOnly, async (ctx, next) => {
  const msg = ctx.message;
  if (msg.chat.type !== 'private') return next();

  const fwdChatId = msg.forward_from_chat?.id;
  const isFromChannel = fwdChatId &&
    String(fwdChatId) === String(process.env.CHANNEL_ID);
  if (!isFromChannel) return next();

  const messageId = msg.forward_from_message_id;
  if (!messageId) {
    return ctx.reply('⚠️ Could not read the post ID from that forwarded message.');
  }

  return ctx.scene.enter(NEW_PRODUCT_WIZARD_ID, { messageId });
});
```

- [ ] **Step 6: Verify the full index.js has no syntax errors**

```bash
node --input-type=module --eval "
import('./src/index.js').catch(e => {
  if (e.message.includes('BOT_TOKEN') || e.message.includes('ECONNREFUSED')) process.exit(0);
  console.error(e.message);
  process.exit(1);
});
"
```

Expected: exits 0 (BOT_TOKEN / Redis missing in test env is expected — any other error means a syntax or import problem).

- [ ] **Step 7: Commit**

```bash
git add src/index.js
git commit -m "feat: wire newProductWizard into bot with session, stage, and forward trigger"
```

---

## Task 3: Update /help and /start tutorial

**Files:**
- Modify: `src/handlers/adminHandler.js`

- [ ] **Step 1: Update the Products section of handleHelp**

Find:
```javascript
    `*Products*\n` +
    `\`/newproduct <msg_id> <price> <qty> <name>\`\n` +
    `  Register a product from a channel post\n` +
    `  e.g. \`/newproduct 42 12.50 3 Blue Tang Fish\`\n\n` +
```

Replace with:
```javascript
    `*Products*\n` +
    `Forward a channel post to this DM → bot walks you through setup\n` +
    `\`/newproduct <msg_id> <price> <qty> <name>\` — manual shortcut\n\n` +
```

- [ ] **Step 2: Update step 2 of the handleAdminStart workflow**

Find:
```javascript
    `2. Register it: \`/newproduct <msg_id> <price> <qty> <name>\`\n` +
```

Replace with:
```javascript
    `2. Forward the post to this DM — bot guides you step by step\n` +
```

- [ ] **Step 3: Commit**

```bash
git add src/handlers/adminHandler.js
git commit -m "docs: update /help and /start for forward-to-create wizard"
```

---

## Task 4: Manual Testing Checklist

Run the bot locally in dev mode (`npm run dev`) and work through each scenario before deploying.

- [ ] **Test 1 — Happy path**
  1. Post anything to your channel
  2. Forward that post to the bot's DM
  3. Bot replies: `📦 New Product Setup — What is the product name?`
  4. Type `Blue Tang Fish` → bot asks for price
  5. Type `12.50` → bot asks for quantity
  6. Type `3` → bot shows confirmation summary
  7. Type `yes` → bot confirms product created
  8. Run `/stock` → new product appears in the list

- [ ] **Test 2 — Invalid price is caught and retried**
  1. Forward a channel post
  2. Type a valid name
  3. When asked for price, type `free` → bot replies `❌ Invalid price. Enter a positive number`
  4. Type `8.00` → proceeds to quantity step

- [ ] **Test 3 — Invalid quantity is caught and retried**
  1. Complete name and price steps
  2. When asked for quantity, type `zero` → bot replies `❌ Enter a whole number greater than 0`
  3. Type `5` → proceeds to confirmation

- [ ] **Test 4 — /cancel exits at any step**
  1. Forward a channel post → wizard starts
  2. When asked for name, type `/cancel`
  3. Bot replies `❌ Cancelled.` and exits
  4. Run `/stock` → no new product was created

- [ ] **Test 5 — Typing "no" at confirmation cancels**
  1. Complete all three prompts
  2. At the confirmation summary, type `no`
  3. Bot replies `❌ Cancelled. No product was created.`

- [ ] **Test 6 — Duplicate post is detected**
  1. Successfully create a product for post #X via the wizard
  2. Forward post #X to bot DM again
  3. Complete all prompts and type `yes`
  4. Bot replies `⚠️ Post #X is already registered as ...`

- [ ] **Test 7 — Non-channel forward is ignored**
  1. Forward a message from a personal chat or group (not your channel) to bot DM
  2. Bot should NOT start the wizard (no response, or passes through normally)

- [ ] **Test 8 — /newproduct shortcut still works**
  1. `/newproduct 99 5.00 2 Test Fish`
  2. Bot confirms product created normally

- [ ] **Test 9 — Other commands blocked inside wizard**
  1. Forward a channel post → wizard starts
  2. Type `/stock` while in the wizard
  3. Bot replies `⚠️ Use /cancel to exit the product wizard first.`

- [ ] **Push to GitHub after all tests pass**

```bash
git push
```
