/**
 * What a module declares about one AI capability (docs/design/domain/platform-ai.md section 4;
 * ADR-0019 decisions 6 and 7). The owning module defines its specs in its `contracts/` and
 * registers them at boot with `registerCapabilities`; the gateway only validates them. This file
 * calls no model, so any module may import it (boundary rule `model-entry-only-from-the-allow-list`).
 */

export const CAPABILITY_AUDIENCES = ['buyer', 'seller', 'admin', 'system'] as const;
export type CapabilityAudience = (typeof CAPABILITY_AUDIENCES)[number];

export const CAPABILITY_TASKS = ['chat', 'extract', 'write', 'vision'] as const;
export type CapabilityTask = (typeof CAPABILITY_TASKS)[number];

export interface CapabilitySpec {
  /** `<owner module>.<name>`, lowercase kebab-case parts, for example `catalog.description-writer`. */
  readonly id: string;
  /** Who calls it; the gateway refuses a caller of another population. */
  readonly audience: CapabilityAudience;
  /** The task type its routes are chosen for (section 6). */
  readonly task: CapabilityTask;
  /** Seller-scoped: a call names a seller and the seller's own switch (SEL-25) is evaluated. */
  readonly sellerScoped: boolean;
  readonly maxInputTokens: number;
  /** A request asking for more output is cut to this. */
  readonly maxOutputTokens: number;
  /** Model rounds one user turn may take; each round is one `run` (0: no tools). */
  readonly maxToolRounds: number;
  /** The longest one `run` may take; a caller may only shorten it. */
  readonly timeoutMs: number;
  /** The prompt version an evaluation pass is bound to (ADR-0019 decision 9). */
  readonly promptVersion: string;
}

const ID =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;
const PROMPT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const positiveInt = (value: unknown, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;

/** Why a spec is invalid, or null when it is valid. Checked once, at registration. */
export function capabilitySpecProblem(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null) return 'a spec is an object';
  const s = spec as Partial<Record<keyof CapabilitySpec, unknown>>;
  if (typeof s.id !== 'string' || !ID.test(s.id)) {
    return 'the id is "<module>.<name>" in kebab-case';
  }
  if (!(CAPABILITY_AUDIENCES as readonly unknown[]).includes(s.audience)) return 'unknown audience';
  if (!(CAPABILITY_TASKS as readonly unknown[]).includes(s.task)) return 'unknown task';
  if (typeof s.sellerScoped !== 'boolean') return 'sellerScoped is a boolean';
  if (!positiveInt(s.maxInputTokens, 1_000_000)) return 'maxInputTokens is 1 to 1,000,000';
  if (!positiveInt(s.maxOutputTokens, 64_000)) return 'maxOutputTokens is 1 to 64,000';
  if (
    typeof s.maxToolRounds !== 'number' ||
    !Number.isInteger(s.maxToolRounds) ||
    s.maxToolRounds < 0 ||
    s.maxToolRounds > 20
  ) {
    return 'maxToolRounds is 0 to 20';
  }
  if (!positiveInt(s.timeoutMs, 120_000)) return 'timeoutMs is 1 to 120,000';
  if (typeof s.promptVersion !== 'string' || !PROMPT_VERSION.test(s.promptVersion)) {
    return 'promptVersion is 1 to 64 of A-Z a-z 0-9 . _ -';
  }
  // R9: no tools under an admin or the system actor.
  if ((s.audience === 'admin' || s.audience === 'system') && s.maxToolRounds !== 0) {
    return 'an admin or system capability has no tool rounds (R9)';
  }
  // A seller-scoped capability is called for a seller: by the seller, or by the system for one.
  if (s.sellerScoped && s.audience !== 'seller' && s.audience !== 'system') {
    return 'only a seller or system capability is seller-scoped';
  }
  return null;
}
