import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  SearchShoppersFailure,
  SearchShoppersRequest,
} from '../../contracts/engagement.facade';
import {
  MAX_SEARCH_KEY_LENGTH,
  MAX_SEARCH_KEYS,
  MAX_SEARCH_PAIRS,
  MAX_SEARCH_WINDOW_HOURS,
  searchKeyOf,
  searchShoppersOf,
  type SearchShoppers,
} from '../../domain/search-shoppers';
import type { EngagementDependencies } from '../engagement-dependencies';

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

/** The request checked whole: a window of at most a long day, and well-formed texts. */
function checkedRequest(
  input: SearchShoppersRequest,
): { readonly window: SearchShoppersRequest['window']; readonly keys: Set<string> } | null {
  const window = input?.window;
  if (!isInstant(window?.from) || !isInstant(window.to)) return null;
  const span = window.to.epochMilliseconds - window.from.epochMilliseconds;
  if (!(span > 0) || span > MAX_SEARCH_WINDOW_HOURS * 3_600_000) return null;
  const raw: readonly unknown[] | null = Array.isArray(input.queries) ? input.queries : null;
  if (raw === null || raw.length > MAX_SEARCH_KEYS) return null;
  const keys = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const length = Array.from(entry).length;
    if (length === 0 || length > MAX_SEARCH_KEY_LENGTH) return null;
    keys.add(searchKeyOf(entry));
  }
  return { window, keys };
}

/**
 * `engagement.count-search-shoppers` (dashboards v2, phase 2: zero-result searches): for texts the
 * caller names (search's zero-result notes of a Market day), the distinct signed-in customers with
 * personalization on who searched each text in the window, and their searches. Rule `system`
 * (reporting's nightly snapshot). Only texts searched by at least ten distinct customers are
 * answered, with counts; the account ids are neither returned nor logged, and the minimum is this
 * module's constant, never the caller's. Guests are never counted. One read-only unit (ADR-0025).
 * A window with more than {@link MAX_SEARCH_PAIRS} (text, account) pairs is
 * `engagement.search-too-large`, never a short count.
 */
export class CountSearchShoppers extends UseCase<
  SearchShoppersRequest,
  readonly SearchShoppers[],
  SearchShoppersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.count-search-shoppers',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SearchShoppersRequest,
  ): Promise<Result<readonly SearchShoppers[], SearchShoppersFailure>> {
    const request = checkedRequest(input);
    if (request === null) return err({ code: 'validation.failed' });
    if (request.keys.size === 0) return ok([]);
    const { market } = context;
    return this.deps.unitOfWork.run<readonly SearchShoppers[], SearchShoppersFailure>(
      market,
      async () => {
        const pairs = await this.deps.events.searchPairs(
          market,
          request.window,
          [...request.keys],
          MAX_SEARCH_PAIRS + 1,
        );
        if (pairs.length > MAX_SEARCH_PAIRS) return err({ code: 'engagement.search-too-large' });
        return ok(searchShoppersOf(pairs, request.keys));
      },
      { readOnly: true },
    );
  }
}
