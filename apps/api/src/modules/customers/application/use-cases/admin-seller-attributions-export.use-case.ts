import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_EXPORT, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { CUSTOMERS_EXPORT_STEP_UP } from '../../contracts/step-up';
import { SellerAttributionsExported } from '../../domain/audit';
import { XLSX_CONTENT_TYPE } from '../ports/sheet-writer';
import { adminOfCall, invalid, isRecord } from '../seller-customers-flow';
import {
  ATTRIBUTION_MAX_SELECTED,
  attributionRowView,
  attributionSelectorOf,
  zonedSelectorOf,
  type AttributionRowView,
  type InvitationDependencies,
} from '../seller-invitations-flow';
import type { AttributionIdsFailure } from './admin-seller-attributions-ids.use-case';

/** Rows read per chunk while the file streams. */
const CHUNK = 500;
/** Ids one request may name (the page's selection); "select all" goes by the filter. */
const MAX_IDS = 1000;

const HEADERS = [
  'Email',
  'Name',
  'Account id',
  'Seller id',
  'Attributed at',
  'Status',
  'Reject reason',
  'Flags',
  'Decided at',
] as const;

const cells = (row: AttributionRowView): string[] => [
  row.email,
  row.displayName ?? '',
  row.accountId,
  row.sellerId,
  row.attributedAt,
  row.status,
  row.rejectReason ?? '',
  row.flags.join(' '),
  row.decidedAt ?? '',
];

export type AttributionsExportFailure =
  | AttributionIdsFailure
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'second-factor.required'; readonly actionKey?: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey?: string }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface AttributionsExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

const OWN_KEYS = new Set(['format', 'ids', 'view', 'q', 'filters']);

/**
 * `customers.admin-seller-attributions-export`: the attributions list as a CSV or XLSX file (it holds
 * sign-in addresses). The rows are the named `ids` (at most 1000; an account with no attribution is
 * dropped) or what `view`, `q` and `filters` match (at most 10,000; more is refused whole). Rule
 * `customers.customers.view` and `.export`, with a fresh two-step code (the Customers export's
 * step-up action), spent in the unit that picks the rows and writes the audit row.
 */
export class AdminSellerAttributionsExport extends UseCase<
  unknown,
  AttributionsExportOutput,
  AttributionsExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-seller-attributions-export',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_CUSTOMER_EXPORT.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<AttributionsExportOutput, AttributionsExportFailure>> {
    if (adminOfCall(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalid('body', 'type');
    for (const key of Object.keys(input)) if (!OWN_KEYS.has(key)) return invalid(key, 'unknown');
    const format = input['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    let named: readonly Id<'Account'>[] | null = null;
    if (input['ids'] !== undefined) {
      const raw = input['ids'];
      if (!Array.isArray(raw)) return invalid('ids', 'type');
      if (raw.length === 0) return invalid('ids', 'required');
      if (raw.length > MAX_IDS)
        return err({ code: 'batch.too-large', max: MAX_IDS, total: raw.length });
      const ids = new Set<Id<'Account'>>();
      for (const part of raw as unknown[]) {
        const parsed = typeof part === 'string' ? parseId<'Account'>(part) : null;
        if (parsed === null || !parsed.ok) return invalid('ids', 'format');
        ids.add(parsed.value);
      }
      named = [...ids];
    }
    const parsed = attributionSelectorOf(input);
    if (!parsed.ok) return parsed;
    const { deps } = this;
    const selector = await zonedSelectorOf(deps, context, parsed.value);
    const { market } = context;

    const picked = await deps.unitOfWork.run<readonly Id<'Account'>[], AttributionsExportFailure>(
      market,
      async () => {
        // The proof first: a refusal commits nothing, and nothing is read for an admin who has none.
        const spent = await deps.stepUp.consume(context, CUSTOMERS_EXPORT_STEP_UP);
        if (!spent.ok) {
          const refusal = spent.error;
          if (
            refusal.code === 'second-factor.required' ||
            refusal.code === 'second-factor.enrolment-required'
          ) {
            return err({ code: refusal.code, actionKey: refusal.actionKey });
          }
          return err({
            code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied',
          });
        }
        let ids: readonly Id<'Account'>[];
        if (named !== null) {
          ids = (await deps.attributions.findListed(market, named)).map((row) => row.accountId);
        } else {
          ids = await deps.attributions.accountIds(market, selector, ATTRIBUTION_MAX_SELECTED + 1);
          if (ids.length > ATTRIBUTION_MAX_SELECTED) {
            const total = await deps.attributions.count(market, selector);
            return err({ code: 'batch.too-large', max: ATTRIBUTION_MAX_SELECTED, total });
          }
        }
        await deps.audit.record(
          context,
          SellerAttributionsExported.entry('seller-attributions-export', {
            after: {
              format,
              rowCount: ids.length,
              selection: named !== null ? 'ids' : 'filter',
              stepUpSessionId: spent.value.sessionId,
              stepUpVerifiedAt: spent.value.verifiedAt,
            },
          }),
        );
        return ok(ids);
      },
    );
    if (!picked.ok) return picked;

    const day = deps.clock.now().toString().slice(0, 10);
    const rows = this.#rows(context, picked.value);
    if (format === 'xlsx') {
      return ok({
        filename: `seller-attributions-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Attributions', flat(rows)),
      });
    }
    return ok({
      filename: `seller-attributions-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(rows),
    });
  }

  async *#rows(
    context: CallContext,
    ids: readonly Id<'Account'>[],
  ): AsyncGenerator<readonly (readonly string[])[]> {
    const { deps } = this;
    yield [[...HEADERS]];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      const read = await deps.unitOfWork.run(
        context.market,
        async () => ok(await deps.attributions.findListed(context.market, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('customers.admin-seller-attributions-export: the read failed');
      yield read.value.map((record) => cells(attributionRowView(record)));
    }
  }
}

async function* flat(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) for (const row of group) yield row;
}

async function* csvChunks(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}
