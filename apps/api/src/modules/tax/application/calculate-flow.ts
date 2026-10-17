import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { TaxAnswer, TaxFailure } from '../contracts/tax.facade';
import { computeLineTax, type TaxStrategyParams } from '../domain/strategy';
import type { TaxDependencies } from './tax-dependencies';

// The tax of order lines under the Market's strategy in force (the active one, else the built-in
// flat strategy). Only checkout calls this, as the signed-in customer; the caller freezes the
// answer on the order, so a later strategy change never touches a placed order.

const MAX_LINES = 200;
/** Keeps every amount a plain money value (and gross, at most 1.5 times it, inside a BIGINT). */
const MAX_AMOUNT = 2n ** 53n - 1n;

export async function calculateTax(
  deps: TaxDependencies,
  context: CallContext,
  input: { readonly lines: unknown },
): Promise<Result<TaxAnswer, TaxFailure>> {
  const caller = context.actor;
  if (caller.kind !== 'authenticated' || caller.population !== 'customer') {
    return err({ code: 'access.denied' });
  }
  const raw = input?.lines;
  if (!Array.isArray(raw) || raw.length > MAX_LINES) {
    return err({ code: 'validation.failed', fields: [{ path: 'lines', code: 'range' }] });
  }
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'tax.unavailable' });

  const fields: { path: string; code: string }[] = [];
  const lines = raw.map((line: Record<string, unknown> | null, index) => {
    const amount = line?.amount;
    if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_AMOUNT) {
      fields.push({ path: `lines.${index}.amount`, code: 'range' });
    }
    if (typeof line?.taxInclusive !== 'boolean') {
      fields.push({ path: `lines.${index}.taxInclusive`, code: 'type' });
    }
    const code = line?.categoryCode;
    if (code !== null && !(typeof code === 'string' && settings.categoryCodes.includes(code))) {
      fields.push({ path: `lines.${index}.categoryCode`, code: 'unknown-category' });
    }
    return {
      amount: amount as bigint,
      taxInclusive: line?.taxInclusive as boolean,
      categoryCode: code as string | null,
    };
  });
  if (fields.length > 0) return err({ code: 'validation.failed', fields });

  return deps.unitOfWork.run<TaxAnswer, TaxFailure>(
    context.market,
    async () => {
      let active;
      try {
        active = await deps.strategies.findActive(context.market);
      } catch {
        // A damaged stored strategy: tax must not be guessed, so the caller fails closed.
        return err({ code: 'tax.unavailable' } as const);
      }
      const params: TaxStrategyParams = active?.params ?? {
        kind: 'flat-rate',
        rateBps: settings.defaultRateBps,
      };
      return ok({
        strategyId: active?.id ?? null,
        lines: lines.map((line) => computeLineTax(line, params)),
      });
    },
    { readOnly: true },
  );
}
