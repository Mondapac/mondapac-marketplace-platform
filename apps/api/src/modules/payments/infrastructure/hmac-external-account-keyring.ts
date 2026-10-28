import { createHmac } from 'node:crypto';
import type { ExternalAccountKeyring } from '../application/ports/external-account-keyring';

/** Separates this hash from any other use of the same key. */
const PURPOSE = 'payments.external-account';

/**
 * HMAC-SHA256 of a default external account's Stripe id, one key per version. The keys come from
 * the environment (`PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K<version>`); a version without a key
 * answers null and is never replaced by another key's value.
 */
export class HmacExternalAccountKeyring implements ExternalAccountKeyring {
  constructor(
    private readonly keys: Readonly<Record<number, string>>,
    private readonly current: number | null,
  ) {}

  currentVersion(): number | null {
    return this.current !== null && this.keys[this.current] !== undefined ? this.current : null;
  }

  hmac(version: number, providerId: string): string | null {
    const key = this.keys[version];
    if (key === undefined) return null;
    const digest = createHmac('sha256', key)
      .update(`${PURPOSE}\0`)
      .update(providerId)
      .digest('hex');
    return `hmac-sha256:k${version}:${digest}`;
  }
}
