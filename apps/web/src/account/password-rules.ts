'use client';

import { useEffect, useState } from 'react';
import { readPasswordRules, type PasswordRules } from './customer-api.ts';

/**
 * The sample preview's rule (the AU Market's numbers in config/markets/AU.json). Never used live:
 * live, the rule is the request Market's, read from the API.
 */
export const SAMPLE_PASSWORD_RULES: PasswordRules = { minLength: 15, maxLength: 128 };

// One read per page load: the rule is the Market's configuration, the same for every form.
let pending: Promise<PasswordRules | null> | null = null;

/** Forgets the read rule (tests). */
export function forgetPasswordRules(): void {
  pending = null;
}

function readOnce(): Promise<PasswordRules | null> {
  pending ??= readPasswordRules().then((result) => {
    if (result.kind === 'ok') return result.value;
    // A failed read is tried again by the next form; the API still checks every password.
    pending = null;
    return null;
  });
  return pending;
}

/**
 * The Market's password length rule for a form that sets a new password: the sample rule in the
 * sample preview; live, null until the API answers (and when it cannot), so no number is ever
 * shown that is not the Market's.
 */
export function usePasswordRules(live: boolean): PasswordRules | null {
  const [rules, setRules] = useState<PasswordRules | null>(live ? null : SAMPLE_PASSWORD_RULES);
  useEffect(() => {
    if (!live) return;
    let current = true;
    void readOnce().then((read) => {
      if (current) setRules(read);
    });
    return () => {
      current = false;
    };
  }, [live]);
  return rules;
}
