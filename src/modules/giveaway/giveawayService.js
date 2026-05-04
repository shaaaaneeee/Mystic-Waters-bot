// src/modules/giveaway/giveawayService.js
import { GiveawayModel } from '../../models/giveaway.js';

export const GiveawayService = {

  async addEntries({ pool, invoiceId, claims, userId }) {
    const entries = claims.map(c => ({
      userId,
      invoiceId,
      claimId: c.claim_id,
    }));
    return GiveawayModel.addEntries({ poolId: pool.id, entries });
  },
};
