/**
 * The most ids one statement takes: the lock statement and the held sum's `IN` list (data design
 * 4.3). One number, so the two cannot drift apart.
 */
export const MAX_STOCK_ITEM_IDS = 1000;
