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
