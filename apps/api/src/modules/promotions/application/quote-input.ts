import { err, money, ok, parseId, parseMinorUnits } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import { normaliseCode, type FieldIssue } from '../domain/promotion';
import type { QuoteLine, QuoteRequest, QuoteShipping } from '../contracts/promotions.facade';

// Reads an untrusted quote body (the admin preview): amounts are digit strings of minor units,
// ids are the platform's ids, and the currency is the Market's, never the body's.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_LINES = 100;
const MAX_SHIPPING = 50;
const MAX_QUANTITY = 10_000;
const ZONE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REFERENCE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseQuoteRequest(
  raw: unknown,
  currency: string,
  defaults: { readonly testMode: boolean },
): Result<QuoteRequest, readonly FieldIssue[]> {
  const issues: FieldIssue[] = [];
  if (!isRecord(raw)) return err([{ path: '', code: 'type' }]);

  const lines: QuoteLine[] = [];
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > MAX_LINES) {
    issues.push({ path: 'lines', code: 'size' });
  } else {
    for (const [index, item] of raw.lines.entries()) {
      const at = `lines.${index}`;
      if (!isRecord(item)) {
        issues.push({ path: at, code: 'type' });
        continue;
      }
      const sellerId = typeof item.sellerId === 'string' ? parseId<'Seller'>(item.sellerId) : null;
      const productId =
        typeof item.productId === 'string' ? parseId<'Product'>(item.productId) : null;
      const price = parseMinorUnits(item.unitPriceMinor);
      const quantity = item.quantity;
      if (typeof item.id !== 'string' || !REFERENCE.test(item.id))
        issues.push({ path: `${at}.id`, code: 'value' });
      if (sellerId === null || !sellerId.ok) issues.push({ path: `${at}.sellerId`, code: 'value' });
      if (productId === null || !productId.ok)
        issues.push({ path: `${at}.productId`, code: 'value' });
      if (!price.ok) issues.push({ path: `${at}.unitPriceMinor`, code: 'value' });
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_QUANTITY
      ) {
        issues.push({ path: `${at}.quantity`, code: 'value' });
      }
      if (
        typeof item.id === 'string' &&
        sellerId?.ok === true &&
        productId?.ok === true &&
        price.ok &&
        typeof quantity === 'number'
      ) {
        lines.push({
          id: item.id,
          sellerId: sellerId.value,
          productId: productId.value,
          unitPrice: money(price.value, currency),
          quantity,
        });
      }
    }
  }

  const shipping: QuoteShipping[] = [];
  if (raw.shipping !== undefined && raw.shipping !== null) {
    if (!Array.isArray(raw.shipping) || raw.shipping.length > MAX_SHIPPING) {
      issues.push({ path: 'shipping', code: 'size' });
    } else {
      for (const [index, item] of raw.shipping.entries()) {
        const at = `shipping.${index}`;
        if (!isRecord(item)) {
          issues.push({ path: at, code: 'type' });
          continue;
        }
        let sellerId: Id<'Seller'> | null = null;
        if (item.sellerId !== undefined && item.sellerId !== null) {
          const parsed =
            typeof item.sellerId === 'string' ? parseId<'Seller'>(item.sellerId) : null;
          if (parsed === null || !parsed.ok) issues.push({ path: `${at}.sellerId`, code: 'value' });
          else sellerId = parsed.value;
        }
        const amount = parseMinorUnits(item.amountMinor);
        if (typeof item.id !== 'string' || !REFERENCE.test(item.id))
          issues.push({ path: `${at}.id`, code: 'value' });
        if (typeof item.zoneCode !== 'string' || !ZONE_PATTERN.test(item.zoneCode)) {
          issues.push({ path: `${at}.zoneCode`, code: 'value' });
        }
        if (!amount.ok) issues.push({ path: `${at}.amountMinor`, code: 'value' });
        if (typeof item.id === 'string' && typeof item.zoneCode === 'string' && amount.ok) {
          shipping.push({
            id: item.id,
            sellerId,
            zoneCode: item.zoneCode,
            amount: money(amount.value, currency),
          });
        }
      }
    }
  }

  let code: string | null = null;
  if (raw.code !== undefined && raw.code !== null) {
    if (typeof raw.code !== 'string' || raw.code.length === 0 || raw.code.length > 64) {
      issues.push({ path: 'code', code: 'value' });
    } else {
      code = normaliseCode(raw.code);
    }
  }
  const commission = parseMinorUnits(raw.orderCommissionMinor ?? '0');
  if (!commission.ok) issues.push({ path: 'orderCommissionMinor', code: 'value' });
  const flag = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      issues.push({ path: key, code: 'value' });
      return fallback;
    }
    return value;
  };
  const isFirstOrder = flag('isFirstOrder', false);
  const testMode = flag('testMode', defaults.testMode);

  if (issues.length > 0 || !commission.ok) return err(issues);
  return ok({
    lines,
    shipping,
    code,
    isFirstOrder,
    testMode,
    orderCommission: money(commission.value, currency),
  });
}
