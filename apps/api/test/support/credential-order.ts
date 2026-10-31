import type { IdentityFakes } from './identity-fakes';

/**
 * Records the order in which a credential unit touches the account, its second factor and its
 * sessions (data design 3.3 lock order: account, then factor, then sessions; Mojtaba S1). The
 * spies call through, so the fakes behave as before. `restore()` removes them.
 */
export function traceCredentialOrder(fakes: IdentityFakes): {
  readonly calls: string[];
  restore(): void;
  /** The account's credential lock came before every factor write and session revocation. */
  accountFirst(): boolean;
} {
  const calls: string[] = [];
  const wrap = <T extends object>(target: T, name: keyof T & string, label: string) => {
    const original = (target[name] as unknown as (...args: unknown[]) => unknown).bind(target);
    return jest.spyOn(target, name as never).mockImplementation(((...args: unknown[]) => {
      calls.push(label);
      return original(...args);
    }) as never);
  };
  const spies = [
    wrap(fakes.accountRepository, 'lockCredential', 'account'),
    wrap(fakes.factorRepository, 'save', 'factor'),
    wrap(fakes.factorRepository, 'removeOf', 'factor'),
    wrap(fakes.sessionRepository, 'revokeAllOf', 'sessions'),
  ];
  return {
    calls,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
    accountFirst: () => {
      const lock = calls.indexOf('account');
      const others = calls.map((c, i) => (c === 'account' ? -1 : i)).filter((i) => i >= 0);
      return lock >= 0 && others.length > 0 && others.every((i) => i > lock);
    },
  };
}
