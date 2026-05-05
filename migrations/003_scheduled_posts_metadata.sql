-- migrations/003_scheduled_posts_metadata.sql
-- Mystic Waters Bot — Scheduled Posts Metadata
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS throughout

-- Drop the old FK columns that assumed products/auctions existed beforehand.
-- These columns stored the wrong kind of ID (telegram message IDs were passed
-- as products.id FK values, which is a different number space).
ALTER TABLE scheduled_posts DROP COLUMN IF EXISTS product_id;
ALTER TABLE scheduled_posts DROP COLUMN IF EXISTS auction_id;

-- Add inline product metadata (used when type = 'product_listing')
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS product_name        TEXT,
  ADD COLUMN IF NOT EXISTS product_price       NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS product_quantity    INTEGER,
  ADD COLUMN IF NOT EXISTS product_description TEXT;

-- Add inline auction metadata (used when type = 'auction_listing')
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS auction_name          TEXT,
  ADD COLUMN IF NOT EXISTS auction_description   TEXT,
  ADD COLUMN IF NOT EXISTS auction_starting_bid  NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS auction_min_increment NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS auction_end_time      TIMESTAMPTZ;

-- channel_message_id is populated after the post fires;
-- allows downstream systems to reference the sent post
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS channel_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_channel
  ON scheduled_posts (channel_message_id)
  WHERE channel_message_id IS NOT NULL;
