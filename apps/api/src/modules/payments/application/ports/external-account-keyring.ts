/**
 * The keys that make `hmac-sha256:k<version>:<hex>` of a default external account id (HP-1
 * condition 2). The keys come from the secret store by reference; the id and the keys never reach
 * a log, an error or a row.
 */
export interface ExternalAccountKeyring {
  /** The version new values are made with, or null when no key is configured. */
  currentVersion(): number | null;

  /**
   * The value for this provider id under the key of `version`, or null when that version's key is
   * missing (never a value made with another key).
   */
  hmac(version: number, providerId: string): string | null;
}

export const EXTERNAL_ACCOUNT_KEYRING = Symbol('EXTERNAL_ACCOUNT_KEYRING');
