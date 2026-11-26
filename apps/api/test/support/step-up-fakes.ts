import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../src/platform/authz';

/**
 * identity's admin step-up in memory: `proofs` fresh proofs wait (unlimited by default); each
 * `consume` spends one and records its action. With none left, the action answers
 * `second-factor.required`, as identity does.
 */
export class FakeStepUp implements StepUpProofConsumer {
  proofs = Number.POSITIVE_INFINITY;
  readonly spent: string[] = [];

  consume(_context: CallContext, actionKey: string) {
    if (this.proofs <= 0) {
      return Promise.resolve(err({ code: 'second-factor.required', actionKey } as const));
    }
    this.proofs -= 1;
    this.spent.push(actionKey);
    return Promise.resolve(
      ok({
        sessionId: '0198a000-0000-7000-8000-0000000000ab' as Id<'Session'>,
        verifiedAt: Temporal.Instant.from('2026-11-01T00:00:00Z'),
      }),
    );
  }
}
