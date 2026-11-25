// Allowed: a price repository reads its own price model.
declare const tx: Record<string, { findFirst(args: unknown): Promise<unknown> }>;

export async function read(): Promise<unknown> {
  return tx.pricingPriceSeries.findFirst({});
}
