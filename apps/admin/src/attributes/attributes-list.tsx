'use client';

import { Badge, Button, toast, type MenuItem, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useState } from 'react';
import { PagedSuperList } from '../shared/paged-list/paged-super-list.tsx';
import type {
  ListPagingMode,
  PagedAnswer,
  PagedFilterField,
  PagedListConfig,
} from '../shared/paged-list/types.ts';
import { AddAttributeDialog } from './add-attribute-dialog.tsx';
import { AttributeRowDialog, type RowChange } from './attribute-row-dialog.tsx';
import { CONVERSIONS } from './restructure-dialogs.tsx';
import {
  API_ATTRIBUTES,
  ATTRIBUTES_PATH,
  DATA_TYPES,
  attributePath,
  languageName,
  textIn,
  type AttributePage,
  type AttributeRow,
  type AttributeStatus,
} from './types.ts';

const LIST_TABS = ['all', 'active', 'draft', 'archived'] as const;
const STATUS_TONE: Record<AttributeStatus, 'success' | 'attention' | 'neutral'> = {
  active: 'success',
  draft: 'attention',
  archived: 'neutral',
};

/** What the list answers besides its rows: the Market's languages, units and feature sets. */
type Answer = PagedAnswer<AttributeRow> &
  Pick<AttributePage, 'locales' | 'units' | 'featureSets' | 'totalAll'>;

/**
 * The attributes as a super list (super list phase 2, list 5), full width: All, Active, Draft and
 * Archived as views, search by code or name, filters (type, feature set, missing language), sort,
 * column picker and the row Actions menu. An attribute opens on its own page; Add attribute… is
 * in the heading.
 */
export function AttributesList({
  paging,
  accountId,
  marketId,
  canEdit,
  canRestructure = false,
  csrfToken,
}: {
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly canEdit: boolean;
  /** `catalog.attribute.restructure`: merge, convert and archive. */
  readonly canRestructure?: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('attributes');
  const tl = useTranslations('attributes.list');
  const [context, setContext] = useState<Pick<Answer, 'locales' | 'units' | 'featureSets'> | null>(
    null,
  );
  const [adding, setAdding] = useState(false);
  const [change, setChange] = useState<{ id: string; kind: RowChange } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const locales = context?.locales ?? null;
  // The columns read the languages from a ref, so the list is not read again when they arrive.
  const localesRef = useRef(locales);
  localesRef.current = locales;

  // The same changes as the attribute page's More menu, each with the same conditions. Items that
  // open a dialog end in an ellipsis; the irreversible ones ask for the attribute's code.
  const rowActions = useCallback(
    (row: AttributeRow): readonly MenuItem[] => {
      const items: MenuItem[] = [
        {
          id: 'open',
          label: tl('actions.open'),
          onSelect: () => window.location.assign(attributePath(row.id)),
        },
      ];
      if (canEdit && row.status !== 'archived') {
        items.push({
          id: 'edit',
          label: tl('actions.edit'),
          onSelect: () => window.location.assign(`${attributePath(row.id)}?edit=1`),
        });
      }
      const active = row.status === 'active';
      if (canRestructure && active && !row.material) {
        items.push({
          id: 'merge-attribute',
          label: tl('actions.merge-attribute'),
          onSelect: () => setChange({ id: row.id, kind: 'merge-attribute' }),
        });
      }
      if (
        canRestructure &&
        active &&
        !row.material &&
        !row.isVariantOption &&
        CONVERSIONS[row.dataType] !== undefined
      ) {
        items.push({
          id: 'convert',
          label: tl('actions.convert'),
          onSelect: () => setChange({ id: row.id, kind: 'convert' }),
        });
      }
      if (canEdit && active && row.material) {
        items.push({
          id: 'relax',
          label: tl('actions.relax'),
          onSelect: () => setChange({ id: row.id, kind: 'relax' }),
        });
      }
      if (canRestructure && active) {
        items.push({
          id: 'archive',
          label: tl('actions.archive'),
          tone: 'critical',
          onSelect: () => setChange({ id: row.id, kind: 'archive' }),
        });
      }
      return items;
    },
    [tl, canEdit, canRestructure],
  );

  const columnDefs = useCallback(
    (id: string, header: string): SuperColumn<AttributeRow> => {
      switch (id) {
        case 'attribute':
          return {
            id,
            header,
            primary: true,
            cell: (row) => (
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <a className="font-semibold wrap-anywhere text-fg" href={attributePath(row.id)}>
                    {localesRef.current === null
                      ? row.code
                      : textIn(
                          row.names,
                          localesRef.current.default,
                          localesRef.current.default,
                          row.code,
                        )}
                  </a>
                  {row.material ? <Badge tone="attention">{t('badge.material')}</Badge> : null}
                  {row.isVariantOption ? <Badge tone="info">{t('badge.variant')}</Badge> : null}
                </p>
                <p className="text-sm wrap-anywhere text-fg-muted">{row.code}</p>
              </div>
            ),
          };
        case 'status':
          return {
            id,
            header,
            corner: true,
            cell: (row) => (
              <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
            ),
          };
        case 'type':
          return { id, header, cell: (row) => t(`type.${row.dataType}`) };
        case 'products':
          return { id, header, numeric: true, cell: (row) => row.productCount };
        case 'feature-sets':
          return { id, header, numeric: true, cell: (row) => row.featureSetCount };
        default:
          return {
            id,
            header,
            cell: (row) =>
              row.missingLocales.length === 0 || localesRef.current === null ? (
                <span className="text-fg-muted">{t('row.all-languages')}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {row.missingLocales.map((locale) => (
                    <Badge key={locale} tone="attention">
                      {t('row.missing', {
                        languages: languageName(locale, localesRef.current?.supported ?? [locale]),
                      })}
                    </Badge>
                  ))}
                </span>
              ),
          };
      }
    },
    [t],
  );

  const config: PagedListConfig<AttributeRow> = useMemo(
    () => ({
      ns: 'attributes.list',
      endpoint: API_ATTRIBUTES,
      rowId: (row) => row.id,
      rowName: (row) =>
        localesRef.current === null
          ? row.code
          : textIn(row.names, localesRef.current.default, localesRef.current.default, row.code),
      tabs: LIST_TABS,
      tabParam: 'status',
      search: { max: 100, param: 'search' },
      sorts: [
        {
          id: 'code',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'name',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'type',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
        {
          id: 'status',
          orders: [tl('sort.az.first'), tl('sort.az.second')],
          defaultDirection: 'asc',
        },
      ],
      defaultSort: 'code',
      fixedColumns: ['attribute'],
      optionalColumns: ['type', 'status', 'products', 'feature-sets', 'languages'],
      defaultColumns: ['type', 'status', 'products', 'feature-sets', 'languages'],
      columnDefs,
      rowActions,
      icon: 'package',
    }),
    [tl, columnDefs, rowActions],
  );

  const fields: readonly PagedFilterField[] = useMemo(() => {
    const other = locales?.supported.filter((locale) => locale !== locales.default) ?? [];
    return [
      {
        id: 'type',
        label: t('filter.type'),
        options: DATA_TYPES.map((type) => ({ value: type, label: t(`type.${type}`) })),
      },
      {
        id: 'usedIn',
        label: t('filter.used-in'),
        options: (context?.featureSets ?? []).map((set) => ({ value: set.id, label: set.code })),
      },
      ...(other.length === 0 || locales === null
        ? []
        : [
            {
              id: 'missing',
              label: t('filter.missing'),
              options: other.map((locale) => ({
                value: locale,
                label: t('filter.missing-in', {
                  language: languageName(locale, locales.supported),
                }),
              })),
            },
          ]),
    ];
  }, [t, locales, context]);

  return (
    <>
      <PagedSuperList
        config={config}
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        fields={fields}
        refreshKey={refresh}
        onAnswer={(answer: PagedAnswer<AttributeRow>) => {
          const { locales: next, units, featureSets } = answer as Answer;
          setContext((current) =>
            current !== null && current.locales === next
              ? current
              : { locales: next, units, featureSets },
          );
        }}
        heading={
          canEdit && locales !== null ? (
            <Button onClick={() => setAdding(true)}>{t('add.open')}</Button>
          ) : null
        }
      />
      {change === null ? null : (
        <AttributeRowDialog
          attributeId={change.id}
          change={change.kind}
          csrfToken={csrfToken}
          onClose={() => setChange(null)}
          onChanged={() => setRefresh((value) => value + 1)}
          onOpenWaiting={() => window.location.assign(`${ATTRIBUTES_PATH}?tab=waiting`)}
        />
      )}
      {adding && context !== null ? (
        <AddAttributeDialog
          locales={context.locales}
          units={context.units}
          csrfToken={csrfToken}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            toast.success(t('add.created'));
            setRefresh((value) => value + 1);
            window.location.assign(attributePath(id));
          }}
        />
      ) : null}
    </>
  );
}
