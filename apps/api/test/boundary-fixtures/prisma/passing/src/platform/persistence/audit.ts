// Allowed: platform/persistence/ names platform's own model.
declare const tx: Record<string, { create(args: unknown): Promise<unknown> }>;

export async function write(): Promise<void> {
  await tx.auditLog.create({});
}
