# Mystic Waters — Telegram Bot

Channel-based sales bot for Telegram. Handles fixed-price products, auctions, invoicing, giveaways, and scheduled posts — all managed via admin DM.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Bot framework | Telegraf 4 |
| Database | PostgreSQL 16 |
| Cache / locks | Redis 7 |
| HTTP server | Express |

---

## How commenting works

Telegram channels don't expose replies via the bot API directly.

1. Create a **linked discussion group** (Channel Settings → Discussion).
2. Telegram auto-forwards every channel post into that group.
3. When buyers reply to a forwarded post, the bot receives it as a group message.
4. `ctx.message.reply_to_message.forward_from_message_id` gives the original channel post ID.
5. That ID maps to `products.telegram_message_id` — the claim or bid target.

The bot must be added to the **discussion group**, not the channel.

---

## Quick start

```bash
git clone https://github.com/your-org/mystic-waters-bot
cd mystic-waters-bot
npm install

cp .env.example .env
# fill in .env

docker compose up -d

# run all migrations
node migrations/run.js

npm run dev
```

---

## Environment variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | From @BotFather |
| `CHANNEL_ID` | Numeric channel ID (e.g. `-1001234567890`) |
| `COMMENT_GROUP_ID` | Linked discussion group ID |
| `ADMIN_IDS` | Comma-separated Telegram user IDs |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `WEBHOOK_URL` | Public HTTPS base URL (production only) |
| `WEBHOOK_SECRET` | Random string securing the webhook path |

---

## Migrations

Run in order. Each file is idempotent.

```bash
node migrations/run.js
```

| File | What it adds |
|---|---|
| `001_initial_schema.sql` | users, products, claims, invoices, post_registry |
| `002_feature_expansion.sql` | auctions, auction_bids, giveaway_pools, giveaway_entries, scheduled_posts |
| `003_scheduled_posts_metadata.sql` | Inline metadata columns on scheduled_posts (removes FK approach) |

---

## Admin workflow

All commands are sent via **DM to the bot**.

### Registering a product or auction

1. Post to your channel.
2. Forward the post to the bot DM.
3. Choose **Fixed-price Product** or **Auction** from the inline keyboard.
4. Complete the wizard. The post is registered in `post_registry`.

Alternatively: `/newproduct <msg_id> <price> <qty> <name>` or `/createauction` (manual wizard).

---

## Admin commands

### Products

```
/newproduct <msg_id> <price> <qty> <name>   manual product registration
/stock                                       all products with stock levels
/claims <post_id>                            who claimed a product
```

When a product sells out, you receive a DM with a **Remove Listing** button to mark it cancelled.

### Auctions

```
/createauction        wizard — asks for channel post ID, name, starting bid, increment, end time
/auctionbids <id>     view all bids for a post
/endauction <id>      force-end an active auction early
/cancelauction <id>   cancel an auction
```

Auctions activate and end automatically via cron (runs every 60s). On end, the bot announces the winner in the group and creates a claim + invoice.

**Bidding:** buyers comment `bid 150` in the discussion group.

### Invoices

```
/invoice @username     generate invoice for one user (shown in DM)
/invoiceall            generate for everyone with pending claims
/invoicehistory        last 50 paid and cancelled invoices
/pending               users with uninvoiced claims
/confirmpaid <id>      mark invoice as paid (also available as inline button on invoice)
/deleteinvoice <id>    cancel invoice — claims are voided, stock is NOT restored
```

When confirmed paid via the inline button, the invoice message is edited (buttons removed).

### Giveaway

```
/newgiveaway      start a new entry pool
/giveawaystats    pool stats and top contributors
/drawgiveaway     draw a winner and close the pool
/cleargiveaway    cancel the pool without drawing
```

Giveaway entries are added automatically when an invoice is confirmed as paid (one entry per claimed item).

### Scheduled posting

```
/schedulepost               wizard — choose type, enter content, set post time
/listscheduled              pending scheduled posts
/editscheduled <id>         cancel + re-schedule an existing pending post
/deletescheduled <id>       cancel a scheduled post
```

**Post types:**
- **Free-form** — any text, posted as-is
- **Product listing** — wizard collects name, price, qty, description; on fire creates the product + post_registry entry automatically
- **Auction listing** — wizard collects name, description, starting bid, increment, auction end time; on fire creates the auction automatically

### Other

```
/start    welcome message and workflow summary
/cancel   exit any active wizard
/help     full command reference
```

---

## Buyer flow

1. Buyer sends `/start` to the bot — prompted to share their phone number for registration.
2. Once registered, they comment `claim` on any product post in the discussion group.
3. Bot confirms the claim and DMs the buyer with a summary.
4. Admin generates and sends an invoice DM; buyer pays off-platform.
5. Admin runs `/confirmpaid <id>` or clicks the button — buyer's claims are recorded as paid.

---

## Race condition handling

Two buyers claiming the last unit simultaneously:

1. **Redis SET NX lock** (5s TTL) — serialises requests per product at the app layer
2. **Postgres atomic UPDATE** with `WHERE quantity_remaining > 0` — database-level guarantee
3. **Unique constraint** on `(user_id, product_id)` in `claims` — prevents double-counting

---

## Project structure

```
mystic-waters-bot/
├── src/
│   ├── index.js                         # Bot setup, stage, routing, webhook
│   ├── handlers/
│   │   ├── adminHandler.js              # All admin commands
│   │   └── claimHandler.js              # claim / bid comment routing
│   ├── middleware/
│   │   └── guards.js                    # adminOnly, commentOnly, registrationRequired
│   ├── models/
│   │   ├── product.js
│   │   ├── auction.js / auctionBid.js
│   │   ├── claim.js / invoice.js
│   │   ├── giveaway.js
│   │   ├── scheduledPost.js
│   │   └── user.js
│   ├── modules/
│   │   ├── auction/
│   │   │   └── auctionWizard.js         # /createauction WizardScene
│   │   ├── giveaway/
│   │   │   └── giveawayService.js
│   │   ├── registration/
│   │   │   └── registrationService.js   # /start + contact share
│   │   └── scheduler/
│   │       ├── scheduleWizard.js        # /schedulepost WizardScene
│   │       └── schedulerService.js      # node-cron + firePost
│   ├── scenes/
│   │   ├── newProductWizard.js          # forward → product WizardScene
│   │   └── newGiveawayWizard.js         # /newgiveaway WizardScene
│   └── services/
│       ├── stockService.js              # Redis-locked atomic claim
│       └── invoiceService.js            # Build + DM invoices
├── config/
│   ├── database.js                      # pg pool
│   └── redis.js                         # ioredis
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_feature_expansion.sql
│   ├── 003_scheduled_posts_metadata.sql
│   └── run.js
├── docker-compose.yml
└── .env.example
```

---

## Production deployment checklist

- [ ] Set `NODE_ENV=production`
- [ ] Provision Postgres + Redis
- [ ] Run all three migrations against prod DB
- [ ] Set `WEBHOOK_URL` to your HTTPS domain
- [ ] Set `WEBHOOK_SECRET` to a random string
- [ ] Add the bot to the discussion group as admin
- [ ] Test forward-to-wizard flow before going live
