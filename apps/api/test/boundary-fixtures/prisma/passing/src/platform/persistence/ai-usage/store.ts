// Allowed: the AI budget models are reserved to platform/persistence/ai-usage/, which names them
// through tx(market).
declare function tx(market: unknown): Record<string, { findMany(args: unknown): Promise<unknown> }>;
declare const market: unknown;

export async function read(): Promise<void> {
  await tx(market).aiBudgetCounter.findMany({});
}
