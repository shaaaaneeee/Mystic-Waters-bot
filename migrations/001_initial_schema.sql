-- migrations/001_initial_schema.sql
-- Mystic Waters Bot — Full Schema
-- Run with: psql $DATABASE_URL < migrations/001_initial_schema.sql

-- ─────────────────────────────────────────────
-- PRODUCTS
-- Each product is tied to a Telegram post.
-- message_id is the post in the channel; it's
-- our primary external key for matching claims.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id               SERIAL PRIMARY KEY,
    telegram_message_id BIGINT UNIQUE NOT NULL,   -- channel post ID
    name             TEXT NOT NULL,
    price            NUMERIC(10, 2) NOT NULL,
    quantity_total   INTEGER NOT NULL CHECK (quantity_total > 0),
    quantity_remaining INTEGER NOT NULL CHECK (quantity_remaining >= 0),
    status           TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'sold_out', 'cancelled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT quantity_remaining_lte_total
        CHECK (quantity_remaining <= quantity_total)
);

-- ─────────────────────────────────────────────
-- USERS
-- Telegram user record, upserted on first claim.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    telegram_id      BIGINT UNIQUE NOT NULL,
    username         TEXT,
    first_name       TEXT,
    last_name        TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- CLAIMS
-- One row per (user, product) claim event.
-- We allow at most one claim per user per product
-- (enforced by unique constraint).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS claims (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    product_id       INTEGER NOT NULL REFERENCES products(id),
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One claim per user per product
    UNIQUE (user_id, product_id)
);

-- ─────────────────────────────────────────────
-- INVOICES
-- One invoice aggregates all confirmed claims
-- for a user. Sent by admin trigger or auto.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    total_amount     NUMERIC(10, 2) NOT NULL,
    status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'sent', 'paid', 'cancelled')),
    sent_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which claims are bundled in this invoice
CREATE TABLE IF NOT EXISTS invoice_claims (
    invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    claim_id         INTEGER NOT NULL REFERENCES claims(id),
    PRIMARY KEY (invoice_id, claim_id)
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_message_id   ON products (telegram_message_id);
CREATE INDEX IF NOT EXISTS idx_products_status        ON products (status);
CREATE INDEX IF NOT EXISTS idx_claims_user_id         ON claims (user_id);
CREATE INDEX IF NOT EXISTS idx_claims_product_id      ON claims (product_id);
CREATE INDEX IF NOT EXISTS idx_claims_status          ON claims (status);
CREATE INDEX IF NOT EXISTS idx_invoices_user_id       ON invoices (user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status        ON invoices (status);

-- ─────────────────────────────────────────────
-- AUTO-UPDATE updated_at
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['products','users','claims','invoices']
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
