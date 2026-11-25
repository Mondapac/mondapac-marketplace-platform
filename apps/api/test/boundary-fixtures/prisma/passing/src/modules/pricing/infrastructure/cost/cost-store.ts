// Allowed: the Cost store reads the Cost model (pricing design 6.5).
declare const tx: Record<string, { findFirst(args: unknown): Promise<unknown> }>;

export async function read(): Promise<unknown> {
  return tx.pricingCostSeries.findFirst({});
}
