# Mystic Waters Bot — Feature Expansion Design
**Date:** 2026-05-04  
**Branch:** feature/full-system-expansion  
**Status:** Approved for implementation

---

## Overview

A holistic, single-branch refactor adding 10 interconnected features to the existing Mystic Waters Telegram bot. Built on top of the working codebase — no restructuring of existing code, new systems added as modules alongside existing flat structure.

---

## Architecture Principles

- **Additive only** — existing working files expanded in-place, not moved
- **New modules** in `src/modules/{registration,auction,giveaway,scheduler}/`
- **Single responsibility per file** — handlers dispatch, services own logic, models own DB
- **All async flows race-condition safe** — Redis NX locks for inventory mutations, DB transactions for atomicity
- **Persistent/recoverable state** — all queues in DB, scheduler rehydrates from DB on boot
- **No buyer-facing bot messages** — buyers interact via group comments only (post-registration)
- **Admin-facing invoice system** — bot generates invoices for seller, seller copies to buyer manually
- **UTC stored, SGT displayed** throughout

---

## Module Map

```
src/
  handlers/
    adminHandler.js       — expanded with all new admin commands
    claimHandler.js       — add registrationRequired check
  services/
    invoiceService.js     — reworked: admin-only, inline keyboard
    stockService.js       — add claim restoration on invoice cancel
  models/
    user.js               — add registration fields
    invoice.js            — updated status lifecycle + audit methods
    claim.js              — unchanged
    product.js            — unchanged
    auction.js            — NEW
    auctionBid.js         — NEW
    scheduledPost.js      — NEW
    giveaway.js           — NEW
  modules/
    registration/
      registrationService.js   — registration state machine, phone gate
    auction/
      auctionWizard.js         — WizardScene for /createauction
      auctionService.js        — bid processing, lifecycle, anti-snipe
    giveaway/
      giveawayService.js       — entry creation, draw, stats
    scheduler/
      schedulerService.js      — cron engine, DB-backed queue
      scheduleWizard.js        — WizardScene for /schedulepost
  scenes/
    newProductWizard.js   — unchanged
  middleware/
    guards.js             — add registrationRequired export
  index.js                — wire all new scenes/handlers/modules
migrations/
  001_initial_schema.sql  — unchanged
  002_feature_expansion.sql — all new tables/columns (already written)
```

---

## Feature Specifications

### 1. Force User Signup (Registration Gate)

**Trigger:** user comments `claim` or `bid X` in group  
**Gate:** `registrationRequired` middleware — checks `users.registration_status = 'registered'`  
**If unregistered:**
- Bot replies in group: *"Please register first → [deep link]"*
- Deep link: `t.me/<botusername>?start=register`
- User taps → DM opens → bot shows registration welcome + contact button
- User shares phone number → bot stores `phone_number`, `registered_at`, sets `registration_status = 'registered'`
- Bot confirms: "You're registered. Go claim!"

**Implementation notes:**
- `registrationRequired(ctx, next)` — single indexed DB read (no Redis, no session)
- Contact button uses Telegraf `Markup.button.contactRequest`
- Bot cannot DM users who never started it → deep link is the only safe path
- On repeat `/start` from registered user → show returning welcome, no contact button

---

### 2. Welcome Message

**Admin `/start`:** existing `handleAdminStart` expanded with new commands in the reference.

**Buyer — first visit (unregistered):**
```
🐠 Welcome to Mystic Waters

We sell rare and curated aquatic life — fish, corals, and collectibles — direct from seller to you.

Tap the button below to register. It takes 10 seconds and lets you claim items and join auctions.

Once registered:
— Comment "claim" on any product post to reserve it
— Comment "bid [amount]" on any auction post to place a bid
— The seller will contact you with payment details

[Share Contact to Register]
```

**Buyer — returning (registered):**
```
🐠 You're registered with Mystic Waters.

— Comment "claim" on product posts to reserve items
— Comment "bid [amount]" on auction posts to place bids
— The seller will reach out when your order is ready
```

---

### 3. Invoice System Rework

**Invoices go to admin only. Buyers receive nothing from the bot.**

**Invoice template (exact):**
```
Hi [name]! You got:

1. [Item] — $[price]
2. [Item] — $[price]

Your total is $[total].

You may:
1. Add $3.50 for mail.
2. Self collect at 520381.
3. Choose to hold for a reasonable amount of time.

Note: Payment has to be made in 24 hours.

Can pn/pl to 97296056 (Ardi).

Thank you for supporting Mystic Waters!
```

**Admin metadata block** (appended below, admin-only visibility):
```
───────────────
📋 Invoice #[id]
👤 @[username] (ID: [telegram_id])
💰 Status: Active
🕐 Generated: [DD/MM/YYYY HH:MM SGT]
📦 Posts: #[msg_id], #[msg_id]
```

**Admin invoice controls** — inline keyboard buttons below the message:
- `[✅ Mark as Paid]` → calls confirm-paid flow
- `[❌ Cancel Invoice]` → calls cancel flow with confirmation

**Status lifecycle:** `active` → `paid` | `cancelled`

**`/confirmpaid <id>` or button:**
1. Verify `status = 'active'` (reject otherwise with clear message)
2. `UPDATE invoices SET status='paid', paid_at=NOW(), paid_confirmed_by=$adminTelegramId`
3. Create giveaway entries (one per claim in invoice) if active pool exists
4. Remove from active queue (filtered by status in queries)

**`/deleteinvoice <id>` or button:**
1. Bot replies: *"Reply CONFIRM to cancel invoice #X"* (with optional reason prompt)
2. On CONFIRM: set `status='cancelled'`, log `cancelled_by`, `cancelled_at`, `cancel_reason`
3. Restore stock atomically: for each claim in invoice, `quantity_remaining += 1` (Redis lock per product)
4. Set claim `status = 'pending'` (back to un-invoiced, visible to `/pending` again)
5. Never hard-delete — preserved in history

---

### 4. Delete Invoice — Stock Restoration

**Race condition safety:**
- Acquire Redis lock per `product_id` before restoring stock
- Check `quantity_remaining < quantity_total` before incrementing (prevent over-restoration)
- All claim status updates in one DB transaction
- Release locks in `finally`

---

### 5. Paid Confirmation System

- Duplicate confirmation prevented: DB `status` check before any update
- Non-admin confirmation prevented: `adminOnly` middleware on command + `paid_confirmed_by` stores who confirmed
- Cancelled invoice confirmation prevented: status check
- Audit trail: `paid_at` + `paid_confirmed_by` permanently stored
- Invoice history preserved: paid invoices queryable via `/invoicehistory` or filtered views

---

### 6. Auction System

**Creation:**
- Admin triggers: forward a channel post to DM → bot detects `post_registry` miss → prompts "Product or Auction?" → routes to `newAuctionWizard`
- OR: `/createauction` command → wizard starts, asks for channel post message ID
- Wizard steps: name → description → starting bid → min increment → end time (SGT `DD/MM HH:MM`) → confirm
- Writes to `auctions` + `post_registry`

**Bidding:**
- User comments `bid 50` in discussion group
- `commentOnly` sets `ctx.channelPostId`
- `post_registry` lookup: if `post_type = 'auction'` → `auctionHandler`
- Registration gate applied before bid processing
- Bid validation:
  - Auction must be `status = 'active'`
  - `amount > current_bid + min_increment` (or `>= starting_bid` if no bids yet)
  - Amount must be a valid positive number
- Redis lock: `auction:lock:<auctionId>`, same NX PX 5000 pattern
- Inside transaction:
  - Insert `auction_bids` row
  - Set previous `is_winning = FALSE`
  - Set new `is_winning = TRUE`
  - Update `auctions.current_bid`, `current_leader_id`
  - **Anti-snipe:** if `end_time - NOW() < 120s`, extend `end_time += 120s`
- Reply in group: *"🏆 Bid of $X accepted! You're currently leading. Ends [time]."*
- On outbid: nothing automated (admin manually monitors)

**Lifecycle (cron, every 60s):**
- Activate: `upcoming` auctions where `start_time <= NOW()` → `active`
- End: `active` auctions where `end_time <= NOW()`:
  - Set `status = 'ended'`, `winner_user_id`, `winner_bid`, `ended_at`
  - Notify admin in DM with winner details
  - Optional: auto-draft invoice (generate but don't send — admin triggers send)

**Admin commands:**
- `/auctionbids <msg_id>` — list all bids for an auction
- `/endauction <msg_id>` — force-end an active auction early
- `/cancelauction <msg_id>` — cancel with confirmation, no winner

---

### 7. Giveaway System

**Pool lifecycle:**
- `/newgiveaway` → wizard: title → prize description → notes → confirm → creates `giveaway_pools` row `status = 'active'`
- Only one active pool at a time enforced at application level
- On `/confirmpaid`: if active pool exists, create one `giveaway_entries` row per claim in the invoice

**Draw:**
- `/drawgiveaway` — uses `crypto.randomInt(0, entryCount)` to select winner
- Sets pool `status = 'drawn'`
- Inserts `giveaway_draws` row
- Announces winner to admin: *"🎉 Winner: @username (ID: X) — drawn from N entries"*

**Stats:**
- `/giveawaystats` — current pool entry count, unique user count, top contributors

**Clear:**
- `/cleargiveaway` — cancels active pool without drawing (requires CONFIRM), preserves history

**Entry rules:**
- One entry per paid claim (not per invoice)
- 3 items in one paid invoice = 3 entries
- Unpaid and cancelled invoices never generate entries

---

### 8. Scheduled Channel Posting

**Creation (`/schedulepost` wizard):**
1. Post type: Free-form / Product listing / Auction listing
2. Content (type-dependent)
3. Date+time in SGT: `DD/MM/YYYY HH:MM`
4. Preview
5. Confirm → stored in `scheduled_posts` with UTC timestamp

**Scheduler engine:**
- `schedulerService.init()` called at boot — loads all `pending` posts, sets `setTimeout` for each
- New posts dynamically added to in-memory queue at creation
- On fire: `bot.telegram.sendMessage(CHANNEL_ID, ...)`, update status to `sent`/`failed`
- Posts within 60s of boot time fire immediately

**Admin controls:**
- `/listscheduled` — pending posts with IDs, SGT times, type, preview snippet
- `/deletescheduled <id>` — cancel with confirmation
- `/editscheduled <id>` — re-runs wizard pre-filled, cancels old, creates new

---

## New Admin Commands Summary

| Command | Description |
|---|---|
| `/createauction` | Start auction creation wizard |
| `/auctionbids <msg_id>` | View all bids for an auction |
| `/endauction <msg_id>` | Force-end an active auction |
| `/cancelauction <msg_id>` | Cancel an auction |
| `/confirmpaid <id>` | Mark invoice as paid |
| `/deleteinvoice <id>` | Cancel invoice (restores stock) |
| `/invoicehistory` | View paid/cancelled invoices |
| `/newgiveaway` | Start a new giveaway pool |
| `/drawgiveaway` | Draw a winner from current pool |
| `/giveawaystats` | Current pool stats |
| `/cleargiveaway` | Cancel active pool without drawing |
| `/schedulepost` | Schedule a channel post |
| `/listscheduled` | List pending scheduled posts |
| `/editscheduled <id>` | Edit a scheduled post |
| `/deletescheduled <id>` | Cancel a scheduled post |

---

## Race Condition Map

| Scenario | Protection |
|---|---|
| Two users claim same last unit | Redis NX lock per product_id |
| Two users bid simultaneously | Redis NX lock per auction_id |
| Stock restore on invoice cancel | Redis NX lock per product_id |
| Double `/confirmpaid` | DB status check before update |
| Double giveaway entry per claim | UNIQUE(pool_id, claim_id) constraint |
| Scheduled post fires twice | DB status = 'pending' check before send |

---

## Schema Changes

See `migrations/002_feature_expansion.sql` — run before deploying.

New tables: `post_registry`, `auctions`, `auction_bids`, `scheduled_posts`, `giveaway_pools`, `giveaway_entries`, `giveaway_draws`  
Modified: `users` (registration fields), `invoices` (status + audit fields)

---

## Telegram API Constraints

- Bot cannot initiate DM to users who haven't started it → registration uses deep link
- Contact sharing uses `Markup.button.contactRequest` (reply keyboard, not inline)
- Inline keyboards used for invoice action buttons
- Rate limits: 30 msg/s global, 20 msg/min per chat — scheduler respects this with 100ms delay between batch sends
- `forward_from_message_id` may be absent if channel has "Restrict saving content" — handled gracefully

---

## Dependencies to Add

- `node-cron` — for auction lifecycle + scheduler engine (lightweight, no new infrastructure)
