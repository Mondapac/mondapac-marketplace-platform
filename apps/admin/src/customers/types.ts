/** One customer account as the lookup answers it (identity slice 8d). */
export interface CustomerAccount {
  readonly accountId: string;
  readonly email: string;
  readonly status: 'active' | 'disabled';
  readonly createdAt: string;
  readonly emailVerified: boolean;
}

export const VIEW_PERMISSION = 'identity.customer-account.view';
export const DISABLE_PERMISSION = 'identity.customer-account.disable';

/** The longest address the API takes (RFC 5321). */
export const EMAIL_MAX = 254;
