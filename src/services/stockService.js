// src/services/stockService.js
import redis from '../../config/redis.js';
import { getClient, query } from '../../config/database.js';
import { ProductModel } from '../models/product.js';
import { UserModel } from '../models/user.js';
import { ClaimModel } from '../models/claim.js';

const LOCK_TTL_MS = 5000;
const LOCK_PREFIX = 'stock:lock:product:';

async function acquireLock(productId) {
  const key = LOCK_PREFIX + productId;
  const result = await redis.set(key, '1', 'NX', 'PX', LOCK_TTL_MS);
  return result === 'OK';
}

async function releaseLock(productId) {
  await redis.del(LOCK_PREFIX + productId);
}

export async function attemptClaim({ telegramUser, product }) {
  const productId = product.id;
  let lockAcquired = false;

  try {
    lockAcquired = await acquireLock(productId);
    if (!lockAcquired) {
      return { success: false, reason: 'busy' };
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // FIX: All DB operations use the transaction client, not the pool.
      // This ensures upsert, exists check, and stock decrement are atomic.

      // Upsert user (using client, inside transaction)
      const { rows: userRows } = await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_id)
         DO UPDATE SET
           username   = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           last_name  = EXCLUDED.last_name,
           updated_at = NOW()
         RETURNING *`,
        [telegramUser.id, telegramUser.username || null,
         telegramUser.first_name || null, telegramUser.last_name || null]
      );
      const user = userRows[0];

      // Duplicate claim check (using client, inside transaction)
      const { rows: existRows } = await client.query(
        `SELECT id FROM claims WHERE user_id = $1 AND product_id = $2`,
        [user.id, productId]
      );
      if (existRows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'duplicate' };
      }

      // Atomic stock decrement
      const updatedProduct = await ProductModel.claimOneUnit(productId, client);
      if (!updatedProduct) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'sold_out' };
      }

      // Register the claim
      const { rows: claimRows } = await client.query(
        `INSERT INTO claims (user_id, product_id, status)
         VALUES ($1, $2, 'confirmed')
         RETURNING *`,
        [user.id, productId]
      );
      const claim = claimRows[0];

      await client.query('COMMIT');
      return { success: true, claim, product: updatedProduct, user };

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } finally {
    if (lockAcquired) await releaseLock(productId);
  }
}

const RESTORE_LOCK_PREFIX = 'stock:restore:product:';

export async function restoreClaimedUnit(productId) {
  const key = RESTORE_LOCK_PREFIX + productId;
  const locked = (await redis.set(key, '1', 'NX', 'PX', LOCK_TTL_MS)) === 'OK';
  if (!locked) throw new Error(`Could not acquire restore lock for product ${productId}`);

  try {
    const { rows } = await query(
      `UPDATE products
       SET quantity_remaining = LEAST(quantity_remaining + 1, quantity_total),
           status = CASE
             WHEN status = 'sold_out' THEN 'active'
             ELSE status
           END,
           updated_at = NOW()
       WHERE id = $1
         AND quantity_remaining < quantity_total
       RETURNING *`,
      [productId]
    );
    return rows[0] || null;
  } finally {
    await redis.del(key);
  }
}
