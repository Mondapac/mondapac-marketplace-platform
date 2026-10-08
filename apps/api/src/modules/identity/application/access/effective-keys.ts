import type { Id, Population } from '@mondapac/shared-kernel';

/**
 * Whose effective permission keys are asked for (identity design 5.2, 5.5). Slice 8a-1 adds the
 * account's role assignment and the permission registry here: all keys of the scope for its
 * system role, otherwise the stored keys of the role that the registry still knows (R7: a key no
 * role grants, or that the registry dropped, is never held).
 */
export interface EffectiveKeysSubject {
  readonly population: Population;
  readonly accountId: Id<'Account'>;
}

const NO_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * The one definition of "which permission keys does this account hold" (identity design 5.2,
 * 8.7; Hassan M2, Ali C5). `AccountAuthorisationCheck` decides every `permissions` rule with it,
 * and the reviewer-notice recipients are evaluated with it, so the two can never disagree.
 *
 * Until slice 8a-1 brings the registry and role keys, no account holds any key: the answer is
 * empty for every population, as the gate has denied every `permissions` rule since slice 2.
 * A customer never holds a key (R2: there is no customer scope).
 */
export function effectiveKeysOf(subject: EffectiveKeysSubject): ReadonlySet<string> {
  switch (subject.population) {
    case 'customer':
    case 'seller':
    case 'admin':
      return NO_KEYS;
  }
}

/** Whether `held` contains every key of `required` (an `allOf` rule; never "any of"). */
export function holdsEvery(held: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((key) => held.has(key));
}
