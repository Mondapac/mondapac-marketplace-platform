import type { Temporal } from '@mondapac/shared-kernel';
import { TOTP } from '../../src/modules/identity/domain/totp';

/**
 * A six-digit code that is none of the codes the server accepts at `now` for a secret: not the
 * code of the current step nor of any tolerated step around it. A fixed wrong code such as
 * 000000 is the real code about once in a million checks, which turns a test red by chance.
 * `codeAt` gives the real code of the secret at an instant (the spec's own helper). There are
 * more candidates than accepted codes, so one is always left.
 */
export function wrongTotpCode(
  codeAt: (at: Temporal.Instant) => string,
  now: Temporal.Instant,
): string {
  const accepted = new Set<string>();
  for (let k = -TOTP.toleranceSteps; k <= TOTP.toleranceSteps; k += 1) {
    accepted.add(codeAt(now.add({ seconds: k * TOTP.periodSeconds })));
  }
  const candidates = ['000000', '111111', '222222', '333333', '444444'];
  const wrong = candidates.find((candidate) => !accepted.has(candidate));
  if (wrong === undefined) throw new Error('wrongTotpCode: every candidate is accepted');
  return wrong;
}
