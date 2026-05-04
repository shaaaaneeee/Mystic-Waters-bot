-- migrations/002_feature_expansion.sql
-- Mystic Waters Bot — Feature Expansion
-- Run with: psql $DATABASE_URL < migrations/002_feature_expansion.sql
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS throughout

-- ─────────────────────────────────────────────
-- USERS — registration fields
-- ─────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_number         TEXT,
  ADD COLUMN IF NOT EXISTS registered_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_status  TEXT NOT NULL DEFAULT 'unregistered';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_registration_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_registration_status_check
        CHECK (registration_status IN ('unregistered', 'pending', 'registered'));
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- INVOICES — updated status lifecycle + audit
-- draft/sent → active; add paid/cancel metadata
-- ─────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS paid_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_confirmed_by  BIGINT,
  ADD COLUMN IF NOT EXISTS cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by       BIGINT,
  ADD COLUMN IF NOT EXISTS cancel_reason      TEXT;

-- Migrate existing status values before changing constraint
UPDATE invoices SET status = 'active' WHERE status IN ('draft', 'sent');

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
    CHECK (status IN ('active', 'paid', 'cancelled'));

-- ─────────────────────────────────────────────
-- POST REGISTRY
-- Enforces: one channel post = one product mode.
-- A post_id can be either a product or auction,
-- never both. Written at product/auction creation.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_registry (
    telegram_message_id  BIGINT PRIMARY KEY,
    post_type            TEXT NOT NULL CHECK (post_type IN ('product', 'auction')),
    ref_id               INTEGER NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Back-fill existing products
INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
  SELECT telegram_message_id, 'product', id FROM products
  ON CONFLICT (telegram_message_id) DO NOTHING;

-- ─────────────────────────────────────────────
-- AUCTIONS
-- One auction per channel post (enforced via
-- post_registry + UNIQUE on telegram_message_id).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auctions (
    id                   SERIAL PRIMARY KEY,
    telegram_message_id  BIGINT UNIQUE NOT NULL,
    name                 TEXT NOT NULL,
    description          TEXT,
    starting_bid         NUMERIC(10, 2) NOT NULL,
    min_increment        NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
    current_bid          NUMERIC(10, 2),
    current_leader_id    INTEGER REFERENCES users(id),
    status               TEXT NOT NULL DEFAULT 'upcoming'
                           CHECK (status IN ('upcoming', 'active', 'ended', 'cancelled')),
    start_time           TIMESTAMPTZ,
    end_time             TIMESTAMPTZ NOT NULL,
    winner_user_id       INTEGER REFERENCES users(id),
    winner_bid           NUMERIC(10, 2),
    ended_at             TIMESTAMPTZ,
    created_by           BIGINT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full bid history — never edited, only appended
CREATE TABLE IF NOT EXISTS auction_bids (
    id          SERIAL PRIMARY KEY,
    auction_id  INTEGER NOT NULL REFERENCES auctions(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    amount      NUMERIC(10, 2) NOT NULL,
    is_winning  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- SCHEDULED POSTS
-- Persistent queue for admin-scheduled channel
-- posts. Survives restarts; cron re-hydrates on boot.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_posts (
    id            SERIAL PRIMARY KEY,
    type          TEXT NOT NULL
                    CHECK (type IN ('free_form', 'product_listing', 'auction_listing')),
    content       TEXT,                                  -- free_form text
    product_id    INTEGER REFERENCES products(id),       -- product_listing
    auction_id    INTEGER REFERENCES auctions(id),       -- auction_listing
    scheduled_at  TIMESTAMPTZ NOT NULL,                  -- stored UTC, displayed SGT
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
    sent_at       TIMESTAMPTZ,
    fail_reason   TEXT,
    cancel_reason TEXT,
    created_by    BIGINT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- GIVEAWAY
-- Pool → entries (one per paid claim) → draw.
-- Entries created only after /confirmpaid.
-- Pool resets after each draw; history preserved.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS giveaway_pools (
    id                SERIAL PRIMARY KEY,
    title             TEXT NOT NULL,
    prize_description TEXT,
    notes             TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'drawn', 'cancelled')),
    created_by        BIGINT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS giveaway_entries (
    id          SERIAL PRIMARY KEY,
    pool_id     INTEGER NOT NULL REFERENCES giveaway_pools(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
    claim_id    INTEGER NOT NULL REFERENCES claims(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (pool_id, claim_id)   -- dedup: one entry per paid claim per pool
);

CREATE TABLE IF NOT EXISTS giveaway_draws (
    id                SERIAL PRIMARY KEY,
    pool_id           INTEGER NOT NULL REFERENCES giveaway_pools(id),
    winner_user_id    INTEGER NOT NULL REFERENCES users(id),
    winning_entry_id  INTEGER NOT NULL REFERENCES giveaway_entries(id),
    drawn_by          BIGINT NOT NULL,
    drawn_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_reg_status         ON users (registration_status);
CREATE INDEX IF NOT EXISTS idx_auctions_status          ON auctions (status);
CREATE INDEX IF NOT EXISTS idx_auctions_end_time        ON auctions (end_time) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction     ON auction_bids (auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_bids_user        ON auction_bids (user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due      ON scheduled_posts (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_giveaway_entries_pool    ON giveaway_entries (pool_id);
CREATE INDEX IF NOT EXISTS idx_giveaway_entries_user    ON giveaway_entries (user_id);

-- ─────────────────────────────────────────────
-- AUTO-UPDATE updated_at — new tables only
-- ─────────────────────────────────────────────
DO $$
DECLARE tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['auctions', 'scheduled_posts']
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;
             CREATE TRIGGER trg_%I_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
            tbl, tbl, tbl, tbl
        );
    END LOOP;
END;
$$;
