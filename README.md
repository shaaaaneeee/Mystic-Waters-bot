# 🐠 Mystic Waters — Telegram Bot

Stock management and invoicing bot for Telegram channel-based product sales.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ | Native async, no GIL, single process |
| Bot framework | Telegraf 4 | Middleware-first, well-maintained |
| Database | PostgreSQL 16 | ACID transactions for race-safe stock |
| Cache / locks | Redis 7 | Sub-ms advisory locks via SET NX |
| HTTP server | Express | Thin webhook receiver |

---

## How "comment claiming" works

Telegram channels don't expose comments directly via bot API.  
The mechanism is:

1. Create a **linked discussion group** for your channel (Channel Settings → Discussion).
2. Telegram automatically forwards every channel post into that group with a special header.
3. When users reply to that forwarded message, the bot receives it as a regular group message.
4. `ctx.message.reply_to_message.forward_from_message_id` gives you the **original channel post ID**.
5. That ID maps to your `products.telegram_message_id` — the claim target.

The bot is added to the **discussion group**, not the channel itself.

---

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/your-org/mystic-waters-bot
cd mystic-waters-bot
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your tokens and IDs

# 3. Start infrastructure
docker compose up -d

# 4. Run migrations
DATABASE_URL=postgresql://bot:botpassword@localhost:5432/mystic_waters npm run migrate

# 5. Start (development — polling mode)
npm run dev
```

---

## Environment variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | From @BotFather |
| `CHANNEL_ID` | Your channel's numeric ID (e.g. `-1001234567890`) |
| `COMMENT_GROUP_ID` | The linked discussion group ID |
| `ADMIN_IDS` | Comma-separated Telegram user IDs |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `WEBHOOK_URL` | Public HTTPS base URL (production only) |
| `WEBHOOK_SECRET` | Random string to secure webhook endpoint |

### Getting your IDs

Forward a message from your channel to @userinfobot to get the channel ID.  
Send `/start` to your bot and check the Telegram update to get user IDs.

---

## Admin commands

All commands are sent via **DM to the bot**.

### Creating a product

After posting in your channel, get the post's message ID (visible in the post URL), then:

```
/newproduct 42 12.50 3 Blue Tang Fish
             ↑   ↑    ↑  ↑
             │   │    │  └─ Product name
             │   │    └──── Quantity available
             │   └───────── Price in SGD
             └───────────── Channel post message_id
```

### Stock & claims

```
/stock                    — List all products with remaining stock
/claims 42                — See who claimed post #42
/pending                  — All users with uninvoiced claims
```

### Invoices

```
/invoice 123456789        — Send invoice to user (Telegram ID)
/invoiceall               — Send to everyone with pending claims
```

---

## Race condition handling

Two users claiming the last unit simultaneously is handled by:

1. **Redis SET NX lock** (5s TTL) — serialises requests per product at app layer
2. **Postgres atomic UPDATE** with `WHERE quantity_remaining > 0` — database-level guarantee
3. **Unique constraint** on `(user_id, product_id)` in `claims` — prevents double-counting

---

## Project structure

```
mystic-waters-bot/
├── src/
│   ├── index.js               # Bot setup, webhook, routing
│   ├── handlers/
│   │   ├── claimHandler.js    # Comment "claim" logic
│   │   └── adminHandler.js    # Admin commands
│   ├── services/
│   │   ├── stockService.js    # Atomic claim with lock
│   │   └── invoiceService.js  # Build + send invoices
│   ├── models/
│   │   ├── product.js
│   │   ├── user.js
│   │   ├── claim.js
│   │   └── invoice.js
│   └── middleware/
│       └── guards.js          # adminOnly, commentOnly
├── config/
│   ├── database.js            # pg pool
│   └── redis.js               # ioredis
├── migrations/
│   ├── 001_initial_schema.sql
│   └── run.js
├── docker-compose.yml
└── .env.example
```

---

## Extending for auction mode

The claim system is designed to swap in an auction handler:

1. Add `auction_mode BOOLEAN` to `products`
2. Create a new `bids` table (user, product, amount)
3. Add a bid handler triggered by messages like `bid 25`
4. At auction close (cron or admin command), pick highest bidder and generate their claim
5. Everything downstream (invoicing, stock) stays the same

---

## Production deployment checklist

- [ ] Set `NODE_ENV=production`
- [ ] Provision Postgres + Redis (Railway, Render, Supabase, etc.)
- [ ] Run migrations against prod DB
- [ ] Set `WEBHOOK_URL` to your HTTPS domain
- [ ] Ensure bot is added to the discussion group as admin
- [ ] Test `/newproduct` and a test claim before going live
