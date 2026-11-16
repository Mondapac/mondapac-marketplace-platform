import { EmailText } from '@mondapac/ui';
import { FallbackId } from '../orders/fallback-id.tsx';
import type { OrderCustomer } from '../orders/types.ts';

/** Name with the email below it; the email alone when no name; the short id when neither. */
export function CustomerCell({
  customer,
  accountId,
}: {
  readonly customer: OrderCustomer | null;
  readonly accountId: string;
}) {
  if (customer === null) return <FallbackId id={accountId} />;
  const name = customer.displayName?.trim() || null;
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" title={accountId}>
      {name === null ? (
        <EmailText address={customer.email} />
      ) : (
        <>
          <div className="font-medium">{name}</div>
          <div className="text-sm text-fg-muted">
            <EmailText address={customer.email} />
          </div>
        </>
      )}
    </div>
  );
}
