// The mail a seller gets when "Move products" changed the category of one of their products (C5a,
// decision 8). Plain text only; the mail transport sends no HTML. Only the product code and the
// category names go in: no reason note, no admin, no id. The final words are Reza's with ux-copy;
// these are working texts, like the certificate expiry notice. The seller panel is English.

import type { Temporal } from '@mondapac/shared-kernel';

/**
 * Sends of one seller email before it is given up (N1): a send that always fails cannot keep the
 * job running (and its source category blocked) for ever.
 */
export const MAX_MOVE_NOTICE_ATTEMPTS = 5;

/**
 * When a seller email whose send failed is tried again: 5 minutes after the first failure,
 * doubling each time (5, 10, 20, 40 minutes). `null` once the attempts are used up: the email is
 * given up and the job may end.
 */
export function moveNoticeRetryAt(
  attemptsSoFar: number,
  now: Temporal.Instant,
): Temporal.Instant | null {
  const attempts = attemptsSoFar + 1;
  if (attempts >= MAX_MOVE_NOTICE_ATTEMPTS) return null;
  return now.add({ minutes: 5 * 2 ** (attempts - 1) });
}

export interface CategoryMoveNoticeMail {
  readonly subject: string;
  readonly text: string;
}

/** One line of plain text: no control or format characters. */
function line(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function categoryMoveNoticeMail(input: {
  readonly productCode: string;
  readonly fromName: string;
  readonly toName: string;
}): CategoryMoveNoticeMail {
  const code = line(input.productCode);
  const from = line(input.fromName);
  const to = line(input.toName);
  return {
    subject: `The category of your product ${code} changed`,
    text: [
      `Our team moved your product ${code} from the category "${from}" to "${to}".`,
      'Your product stays on sale. If the new category asks for details your product does not have yet, add them the next time you edit it.',
    ].join('\n\n'),
  };
}
