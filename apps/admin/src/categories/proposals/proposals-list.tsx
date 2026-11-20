'use client';

import { toast, type MenuItem, type SuperColumn, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { languageName } from '../../attributes/types.ts';
import { BulkDecideDialog, type BulkRow } from '../../shared/paged-list/bulk-decide-dialog.tsx';
import { PagedSuperList } from '../../shared/paged-list/paged-super-list.tsx';
import type { ListPagingMode, PagedListConfig } from '../../shared/paged-list/types.ts';
import { When } from '../../shared/when.tsx';
import { directionOf } from '../tree-model.ts';
import type { TreeBody } from '../types.ts';
import { headline, pathText } from './model.ts';
import { ProposalDecisionDialog, type ProposalDecision } from './proposal-decision-dialog.tsx';
import { API_PROPOSALS, REJECT_REASONS, type Proposal } from './types.ts';

/** A waiting proposal with what the API names the caller may do on it: `approve`, `reject`. */
export type ProposalRow = Proposal & { readonly actions: readonly string[] };
const ACTIONS: readonly ProposalDecision[] = ['approve', 'reject'];

/**
 * The waiting category proposals as a super list (super list phase 2, list 12): oldest first,
 * searched by the proposed name. Approve…, Reject… and Seller's shelves… are in the row's Actions
 * menu; the two decisions open a confirmation dialog, and the ticked rows of a page can be
 * approved or rejected together (at most 50, each decided as the caller). The proposal holds a
 * seller's own words: plain text, with the language and direction of each name.
 */
export function ProposalsList({
  paging,
  accountId,
  marketId,
  csrfToken,
  tree,
  onShelves,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly tree: TreeBody;
  readonly onShelves: (sellerId: string, storeName: string | null) => void;
}) {
  const t = useTranslations('categories.proposals');
  const tl = useTranslations('categories.proposals.list');
  const [open, setOpen] = useState<{ row: ProposalRow; decision: ProposalDecision } | null>(null);
  const [bulk, setBulk] = useState<{
    action: ProposalDecision;
    rows: readonly ProposalRow[];
  } | null>(null);
  const [bulkReason, setBulkReason] = useState('');
  const [refresh, setRefresh] = useState(0);
  const nameOf = useCallback(
    (row: Proposal) => headline(row.texts, tree.defaultLocale),
    [tree.defaultLocale],
  );
  const storeOf = useCallback((row: Proposal) => row.storeName ?? t('unknown-store'), [t]);

  const rowActions = useCallback(
    (row: ProposalRow): readonly MenuItem[] => [
      ...ACTIONS.filter((id) => row.actions.includes(id)).map((id) => ({
        id,
        label: t(`actions.${id}`),
        onSelect: () => setOpen({ row, decision: id }),
      })),
      {
        id: 'shelves',
        label: t('actions.shelves'),
        onSelect: () => onShelves(row.sellerId, row.storeName),
      },
    ],
    [t, onShelves],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<ProposalRow> => {
      switch (id) {
        case 'proposal':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <ul
                className="flex flex-col gap-1"
                aria-label={t('names-label', { name: nameOf(row) })}
              >
                {row.texts.map((text) => (
                  <li key={text.locale} className="text-sm">
                    <span className="text-fg-muted">
                      {languageName(text.locale, tree.supportedLocales)}:{' '}
                    </span>
                    <span
                      lang={text.locale}
                      dir={directionOf(text.locale)}
                      className="font-medium wrap-anywhere text-fg"
                    >
                      {text.name}
                    </span>
                    {text.description === null || text.description === '' ? null : (
                      <span
                        lang={text.locale}
                        dir={directionOf(text.locale)}
                        className="block wrap-anywhere text-fg-muted"
                      >
                        {text.description}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ),
          };
        case 'store':
          return {
            id,
            header,
            cell: (row) => <span className="wrap-anywhere">{storeOf(row)}</span>,
          };
        case 'under': {
          return {
            id,
            header,
            cell: (row) => {
              const path = pathText(tree.categories, row.platformParentId, tree.defaultLocale);
              return (
                <span className="wrap-anywhere">{path === '' ? t('unknown-parent') : path}</span>
              );
            },
          };
        }
        default:
          return {
            id,
            header,
            skeleton: 'date',
            cell: (row) => <When iso={row.createdAt} missing="" />,
          };
      }
    },
    [t, nameOf, storeOf, tree],
  );

  const bulkRun = (action: ProposalDecision) => (rows: readonly ProposalRow[]) => {
    setBulkReason('');
    setBulk({ action, rows });
  };
  const config: PagedListConfig<ProposalRow> = useMemo(
    () => ({
      ns: 'categories.proposals.list',
      endpoint: API_PROPOSALS,
      rowId: (row) => row.id,
      rowName: (row) => nameOf(row),
      tabs: ['waiting'],
      search: { max: 100 },
      sorts: [
        {
          id: 'created',
          orders: [tl('sort.date.first'), tl('sort.date.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'created',
      fixedColumns: ['proposal'],
      optionalColumns: ['store', 'under', 'requested'],
      defaultColumns: ['store', 'under', 'requested'],
      columnDefs,
      rowActions,
      bulk: [
        { id: 'approve', label: t('bulk.approve'), run: bulkRun('approve') },
        { id: 'reject', label: t('bulk.reject'), run: bulkRun('reject') },
      ],
      icon: 'package',
    }),
    [t, tl, nameOf, columnDefs, rowActions],
  );
  const rows: readonly BulkRow[] = bulk?.rows ?? [];

  return (
    <PagedSuperList
      config={config}
      paging={paging}
      accountId={accountId}
      marketId={marketId}
      refreshKey={refresh}
      dialogs={
        <>
          <ProposalDecisionDialog
            id={open?.row.id ?? null}
            version={open?.row.version ?? 0}
            name={open === null ? '' : nameOf(open.row)}
            store={open === null ? '' : storeOf(open.row)}
            decision={open?.decision ?? null}
            csrfToken={csrfToken}
            onClose={() => setOpen(null)}
            onSettled={(why) => {
              setOpen(null);
              if (why !== undefined) toast.error(t(`error.${why}`));
              setRefresh((value) => value + 1);
            }}
          />
          {bulk === null ? null : (
            <BulkDecideDialog
              endpoint={`${API_PROPOSALS}/bulk-decide`}
              action={bulk.action}
              rows={rows.map(({ id, version }) => ({ id, version }))}
              title={t(`bulk.dialog.${bulk.action}.title`, { count: rows.length })}
              body={t(`bulk.dialog.${bulk.action}.body`, { count: rows.length })}
              confirm={t(`bulk.dialog.${bulk.action}.confirm`, { count: rows.length })}
              ready={bulk.action === 'approve' || bulkReason !== ''}
              extraBody={bulk.action === 'reject' ? { reasonCode: bulkReason } : {}}
              csrfToken={csrfToken}
              fields={
                bulk.action === 'reject' ? (
                  <Select
                    label={t('reason-label')}
                    placeholder={t('reason-choose')}
                    value={bulkReason}
                    options={REJECT_REASONS.map((code) => ({
                      value: code,
                      label: t(`reason.${code}`),
                    }))}
                    onChange={(event) => setBulkReason(event.target.value)}
                  />
                ) : null
              }
              onClose={() => setBulk(null)}
              onFinished={() => {
                setRefresh((value) => value + 1);
              }}
            />
          )}
        </>
      }
    />
  );
}
