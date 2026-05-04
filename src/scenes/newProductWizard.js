// src/scenes/newProductWizard.js
import { Scenes } from 'telegraf';
import { ProductModel } from '../models/product.js';
import { query } from '../../config/database.js';

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
