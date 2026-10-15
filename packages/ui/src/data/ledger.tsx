import { Badge, type BadgeTone } from '../form/badge.tsx';

export interface LedgerTotalItem {
  readonly id: string;
  readonly label: string;
  /** The amount, already formatted for the reader. */
  readonly value: string;
  /** The closing figure (balance) is set apart. */
  readonly emphasis?: boolean;
}

/** Totals as tiles: two per row on phones, one row from the large breakpoint. */
export function LedgerTotals({ items }: { readonly items: readonly LedgerTotalItem[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.id}
          className={`min-w-0 rounded-lg border p-3 ${
            item.emphasis === true ? 'border-line-control bg-subtle' : 'border-line bg-surface'
          }`}
        >
          <dt className="text-sm text-fg-muted">{item.label}</dt>
          <dd className="mt-1 break-words text-lg font-semibold tabular-nums text-fg">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface LedgerRow {
  readonly id: string;
  /** ISO instant for the `<time>` element. */
  readonly dateTime: string;
  readonly when: string;
  readonly order: string;
  /** Full id, shown as the tooltip of the short order reference. */
  readonly orderTitle?: string;
  readonly kind: string;
  readonly kindTone: BadgeTone;
  /** The amount, already formatted, with its sign. */
  readonly amount: string;
}

export interface LedgerTableLabels {
  readonly caption: string;
  readonly when: string;
  readonly order: string;
  readonly kind: string;
  readonly amount: string;
}

/**
 * A ledger as a table: date, order, kind, amount. The amount column is end-aligned (header and
 * cells alike) and tabular; the table scrolls inside its own box on narrow screens.
 */
export function LedgerTable({
  rows,
  labels,
}: {
  readonly rows: readonly LedgerRow[];
  readonly labels: LedgerTableLabels;
}) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-120 text-start text-sm">
        <caption className="sr-only">{labels.caption}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
              {labels.when}
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
              {labels.order}
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
              {labels.kind}
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-3 text-end font-medium">
              {labels.amount}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="whitespace-nowrap px-3 py-3">
                <time dateTime={row.dateTime}>{row.when}</time>
              </td>
              <td
                className="whitespace-nowrap px-3 py-3 font-medium text-fg"
                title={row.orderTitle}
              >
                {row.order}
              </td>
              <td className="whitespace-nowrap px-3 py-3">
                <Badge tone={row.kindTone}>{row.kind}</Badge>
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-end tabular-nums">{row.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
