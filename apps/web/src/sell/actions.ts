'use server';

import {
  loadSellerSignUp,
  resendSellerVerification,
  submitSellerSignUp,
} from '../storefront/source.ts';
import type { SellerSignUpAnswer } from '../storefront/types.ts';
import { checkSignUp, cleanSignUp } from './sign-up-rules.ts';

// The sell page's server actions: the storefront's BFF side of seller sign-up. Next.js refuses a
// server action whose Origin is not this host. Inputs are checked again here, since a browser may
// skip the form's checks; nothing personal is logged.

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Sends the seller sign-up. The answer is the same for every valid address (identity AC 21). */
export async function signUpSeller(raw: unknown): Promise<SellerSignUpAnswer> {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const name = text(record['name']);
  const email = text(record['email']);
  const password = text(record['password']);
  if (name === null || email === null || password === null) return { kind: 'failed' };
  const setup = await loadSellerSignUp();
  const input = cleanSignUp({ name, email, password });
  const fields = checkSignUp(input, {
    min: setup.passwordMinLength,
    max: setup.passwordMaxLength,
  });
  if (Object.keys(fields).length > 0) return { kind: 'invalid', fields };
  return submitSellerSignUp(input);
}

/** "Send it again": the same answer whether or not the address waits for confirmation. */
export async function resendSellerEmail(raw: unknown): Promise<SellerSignUpAnswer> {
  const email = text(raw)?.trim() ?? '';
  if (email === '') return { kind: 'failed' };
  return resendSellerVerification(email);
}
