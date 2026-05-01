// src/services/stockService.js
/**
 * RACE CONDITION STRATEGY
 * ───────────────────────
 * Problem: Two users hit "claim" simultaneously for the last unit.
 *
 * Solution — two-layer defense:
 *
 * Layer 1 (Redis advisory lock):
 *   Acquire a short-lived lock per product before touching Postgres.
 *   This serialises concurrent requests at the application level.
 *   Lock TTL = 5s (more than enough for a DB round-trip).
 *
 * Layer 2 (Postgres atomic UPDATE):
 *   The UPDATE itself filters on quantity_remaining > 0.
 *   Even if two requests somehow bypass Redis, only one will
 *   decrement successfully — the other gets 0 rows back.
 *
 * This gives us serializability without needing SERIALIZABLE isolation,
 * and without long-held DB locks that would hurt throughput.
 */

import redis from '../../config/redis.js';
import { getClient } from '../../config/database.js';
import { ProductModel } from '../models/product.js';
import { UserModel } from '../models/user.js';
import { ClaimModel } from '../models/claim.js';

const LOCK_TTL_MS = 5000;
const LOCK_PREFIX  = 'stock:lock:product:';

async function acquireLock(productId) {
  const key = LOCK_PREFIX + productId;
  // SET NX PX = set if not exists, with millisecond expiry
  const result = await redis.set(key, '1', 'NX', 'PX', LOCK_TTL_MS);
  return result === 'OK';
}

async function releaseLock(productId) {
  await redis.del(LOCK_PREFIX + productId);
}

/**
 * Attempt to claim one unit of a product for a user.
 *
 * Returns:
 *   { success: true,  claim, product }   — claim registered
 *   { success: false, reason: string }   — rejected (sold out, duplicate, etc.)
 */
export async function attemptClaim({ telegramUser, product }) {
  const productId = product.id;
  let lockAcquired = false;

  try {
    // ── Layer 1: Redis lock ──────────────────────────────────────
    lockAcquired = await acquireLock(productId);
    if (!lockAcquired) {
      // Another request is mid-claim for this product; retry advice
      return { success: false, reason: 'busy' };
    }

    // ── Open a DB transaction ────────────────────────────────────
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Upsert user inside the same transaction
      const user = await UserModel.upsert({
        telegramId: telegramUser.id,
        username:   telegramUser.username,
        firstName:  telegramUser.first_name,
        lastName:   telegramUser.last_name,
      }, client);

      // Duplicate claim guard inside the same transaction
      const alreadyClaimed = await ClaimModel.exists({
        userId: user.id,
        productId,
      }, client);
      if (alreadyClaimed) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'duplicate' };
      }

      // ── Layer 2: Atomic stock decrement ──────────────────────
      const updatedProduct = await ProductModel.claimOneUnit(productId, client);
      if (!updatedProduct) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'sold_out' };
      }

      // Register the claim
      const claim = await ClaimModel.create({ userId: user.id, productId }, client);

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
