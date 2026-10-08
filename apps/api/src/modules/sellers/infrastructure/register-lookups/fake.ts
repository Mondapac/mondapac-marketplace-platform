import type { MarketId } from '@mondapac/shared-kernel';
import type { AppConfig } from '../../../../platform/config/app-config';
import type {
  BusinessRegisterLookup,
  RegisterAnswer,
  RegisterLookupRequest,
} from '../../application/ports/business-register-lookup';

export const FAKE_REGISTER_ADAPTER = 'fake';

/** The fake was asked to start outside an explicit development or test environment. */
export class FakeRegisterLookupRefusedError extends Error {
  override readonly name = 'FakeRegisterLookupRefusedError';
  constructor() {
    super(
      'The "fake" register lookup answers from a table, not from a register: it starts only when ' +
        'NODE_ENV is explicitly "development" or "test"',
    );
  }
}

/**
 * The same refusal as the sellers stack-secret stand-in: a Region Stack that names the `fake`
 * adapter in any other environment must not start, or sellers would be "matched" against nothing.
 */
export function fakeRegisterLookupAllowed(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): boolean {
  const { nodeEnv, nodeEnvExplicit } = environment;
  return nodeEnvExplicit === true && (nodeEnv === 'development' || nodeEnv === 'test');
}

export function assertFakeRegisterLookupAllowed(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): void {
  if (!fakeRegisterLookupAllowed(environment)) throw new FakeRegisterLookupRefusedError();
}

/**
 * The deterministic stand-in for tests and development (sellers design 4.1, brief s7: CI never
 * reaches a network). It answers from a table keyed by the normalised identifier; a value not in
 * the table is answered by its last character: `0` not found, `1` cancelled, `2` unavailable,
 * anything else active with a register name derived from the value. It makes no call and keeps
 * a count and the Markets it was asked for, so a test can assert "no call was made".
 */
export class FakeRegisterLookup implements BusinessRegisterLookup {
  readonly code = FAKE_REGISTER_ADAPTER;
  readonly performsLookups = true;
  /** The requests received, as Market and scheme only (never a value). */
  readonly calls: { readonly marketId: MarketId; readonly scheme: string }[] = [];
  /** Set to make the next call reject, as a broken adapter would. */
  failWith: Error | null = null;
  /** Test hook: runs while the call is "waiting" on the register, before it answers. */
  whileWaiting: (() => void | Promise<void>) | null = null;

  constructor(private readonly answers: ReadonlyMap<string, RegisterAnswer> = new Map()) {}

  async lookup(request: RegisterLookupRequest): Promise<RegisterAnswer> {
    await this.whileWaiting?.();
    return this.answer(request);
  }

  private answer(request: RegisterLookupRequest): Promise<RegisterAnswer> {
    this.calls.push({ marketId: request.market.marketId, scheme: request.scheme });
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const configured = this.answers.get(request.identifier);
    if (configured !== undefined) return Promise.resolve(configured);
    const last = request.identifier.slice(-1);
    if (last === '0') return Promise.resolve({ outcome: 'not-found' });
    if (last === '1') return Promise.resolve({ outcome: 'cancelled' });
    if (last === '2') return Promise.resolve({ outcome: 'unavailable' });
    return Promise.resolve({
      outcome: 'active',
      values: {
        businessName: `Fake Trading ${request.identifier.slice(-4)}`,
        registeredForIndirectTax: null,
        postcode: null,
      },
    });
  }
}
