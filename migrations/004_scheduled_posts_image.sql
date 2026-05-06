ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS image_file_id TEXT;
