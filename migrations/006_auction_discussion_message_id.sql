ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS discussion_message_id BIGINT;
