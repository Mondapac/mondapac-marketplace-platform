'use client';

import {
  Badge,
  Button,
  CARD_TABLE,
  DataList,
  EmptyState,
  LoadError,
  SearchSelect,
  Select,
  SkeletonRows,
  Tabs,
  type DataListRow,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import { changeLineOf } from './history.ts';
import { useSelectLabels } from './select-labels.ts';
import {
  API_ATTRIBUTES,
  DETAIL_TABS,
  directionOf,
  languageName,
  textIn,
  type AttributeChange,
  type AttributeDetail,
  type DetailTab,
} from './types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly detail: AttributeDetail }
  | { readonly state: 'missing' }
  | { readonly state: 'failed' };

const CHOICE_TYPES = new Set(['select', 'multi-select']);

/**
 * One attribute, read only (plan 16): its name and badges, then four sub-tabs. Details shows the
 * name in a chosen language and the settings; Values lists the options with their product counts
 * and, on request, a second language next to the default; Used in lists the feature sets; History
 * lists the revisions newest first with what changed.
 */
export function AttributeDetailPanel({
  attributeId,
  onClose,
}: {
  readonly attributeId: string | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations('attributes.detail');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [tab, setTab] = useState<DetailTab>('details');
  const latest = useRef(0);

  const fetchDetail = useCallback(async () => {
    if (attributeId === null) return;
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<AttributeDetail>(
      'GET',
      `${API_ATTRIBUTES}/${encodeURIComponent(attributeId)}`,
    );
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', detail: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: result.failure.status === 404 ? 'missing' : 'failed' });
  }, [attributeId]);

  useEffect(() => {
    setTab('details');
    void fetchDetail();
  }, [fetchDetail]);

  if (attributeId === null) {
    return <EmptyState size="card" icon="sliders" title={t('none')} body={t('none-body')} />;
  }

  return (
    <section
      aria-label={t('label')}
      aria-busy={load.state === 'loading'}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
    >
      {load.state === 'loading' ? <SkeletonRows label={t('loading')} rows={6} /> : null}
      {load.state === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchDetail()}
        />
      ) : null}
      {load.state === 'missing' ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-fg-muted">{t('missing')}</p>
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      ) : null}
      {load.state === 'ready' ? (
        <>
          <Header detail={load.detail} onClose={onClose} />
          <Tabs
            label={t('tabs')}
            items={DETAIL_TABS.map((id) => ({ id, label: t(`tab.${id}`) }))}
            activeId={tab}
            onSelect={(id) => setTab(id as DetailTab)}
          />
          {tab === 'details' ? <DetailsTab detail={load.detail} /> : null}
          {tab === 'values' ? <ValuesTab detail={load.detail} /> : null}
          {tab === 'used-in' ? <UsedInTab detail={load.detail} /> : null}
          {tab === 'history' ? <HistoryTab detail={load.detail} /> : null}
        </>
      ) : null}
    </section>
  );
}

function Header({
  detail,
  onClose,
}: {
  readonly detail: AttributeDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations('attributes');
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold wrap-anywhere text-fg">{name}</h2>
          <Badge tone={detail.status === 'active' ? 'success' : 'neutral'}>
            {t(`status.${detail.status}`)}
          </Badge>
          {detail.material ? <Badge tone="attention">{t('badge.material')}</Badge> : null}
          {detail.isVariantOption ? <Badge tone="info">{t('badge.variant')}</Badge> : null}
        </div>
        <p className="text-sm wrap-anywhere text-fg-muted">
          {detail.code} · {t(`type.${detail.dataType}`)}
        </p>
      </div>
      <Button variant="secondary" onClick={onClose}>
        {t('detail.close')}
      </Button>
    </div>
  );
}

function DetailsTab({ detail }: { readonly detail: AttributeDetail }) {
  const t = useTranslations('attributes');
  const selectLabels = useSelectLabels();
  const { locales } = detail;
  const [locale, setLocale] = useState(locales.default);
  const options: readonly SearchSelectOption[] = locales.supported.map((tag) => ({
    value: tag,
    label: languageName(tag),
    description: tag,
  }));
  const picked = options.find((option) => option.value === locale) ?? null;
  const name = detail.names[locale];
  const language = languageName(locale);
  const yesNo = (value: boolean) => (value ? t('yes') : t('no'));
  const rows: DataListRow[] = [
    { label: t('field.code'), value: detail.code },
    { label: t('field.type'), value: t(`type.${detail.dataType}`) },
    { label: t('field.localizable'), value: yesNo(detail.localizable) },
    { label: t('field.variant'), value: yesNo(detail.isVariantOption) },
    { label: t('field.material'), value: yesNo(detail.material) },
    ...(detail.bounds.maxLength === undefined
      ? []
      : [{ label: t('field.max-length'), value: String(detail.bounds.maxLength) }]),
    ...(detail.bounds.min === undefined
      ? []
      : [{ label: t('field.min'), value: String(detail.bounds.min) }]),
    ...(detail.bounds.max === undefined
      ? []
      : [{ label: t('field.max'), value: String(detail.bounds.max) }]),
    { label: t('field.status'), value: t(`status.${detail.status}`) },
    { label: t('field.revision'), value: String(detail.revisionNo) },
    {
      label: t('field.created'),
      value: (
        <span className="flex flex-col gap-1">
          <When iso={detail.createdAt} missing={t('none')} />
          <span className="text-sm text-fg-muted">{t(`author.${detail.createdByKind}`)}</span>
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="attribute-text" className="flex flex-col gap-3">
        <h3 id="attribute-text" className="font-semibold text-fg">
          {t('detail.text-in', { language })}
        </h3>
        <div className="max-w-xs">
          <SearchSelect
            label={t('detail.language')}
            options={options}
            value={picked}
            labels={selectLabels}
            onChange={(option) => setLocale(option?.value ?? locales.default)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">{t('field.name')}</span>
          {name === undefined ? (
            <span>
              <Badge tone="attention">{t('row.missing', { languages: language })}</Badge>
            </span>
          ) : (
            <span lang={locale} dir={directionOf(locale)} className="wrap-anywhere text-fg">
              {name}
            </span>
          )}
        </div>
        {detail.missingLocales.length > 0 ? (
          <p className="text-sm text-fg-muted">
            {t('detail.missing-anywhere', {
              languages: detail.missingLocales.map(languageName).join(', '),
            })}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="attribute-settings" className="flex flex-col gap-3">
        <h3 id="attribute-settings" className="font-semibold text-fg">
          {t('detail.settings')}
        </h3>
        <DataList rows={rows} missing={t('none')} />
      </section>
    </div>
  );
}

function ValuesTab({ detail }: { readonly detail: AttributeDetail }) {
  const t = useTranslations('attributes');
  const { locales } = detail;
  const [second, setSecond] = useState('');
  if (!CHOICE_TYPES.has(detail.dataType)) {
    return <p className="text-fg-muted">{t('values.not-choice')}</p>;
  }
  if (detail.options.length === 0) {
    return <p className="text-fg-muted">{t('values.empty')}</p>;
  }
  const others = locales.supported.filter((locale) => locale !== locales.default);
  const defaultLanguage = languageName(locales.default);
  const columns = [
    { id: 'value', label: t('values.col.value', { language: defaultLanguage }) },
    ...(second === ''
      ? []
      : [{ id: 'second', label: t('values.col.value', { language: languageName(second) }) }]),
    { id: 'products', label: t('values.col.products') },
    { id: 'status', label: t('values.col.status') },
  ];
  return (
    <div className="flex flex-col gap-3">
      {others.length > 0 ? (
        <div className="max-w-xs">
          <Select
            name="second-language"
            label={t('values.second', { language: defaultLanguage })}
            value={second}
            placeholder={t('values.second-none')}
            options={others.map((locale) => ({ value: locale, label: languageName(locale) }))}
            onChange={(event) => setSecond(event.target.value)}
          />
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-line">
        <table className={CARD_TABLE.table}>
          <caption className="sr-only">{t('detail.tab.values')}</caption>
          <thead className={CARD_TABLE.head}>
            <tr>
              {columns.map((column) => (
                <th key={column.id} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={CARD_TABLE.body}>
            {detail.options.map((option) => {
              const label = option.labels[locales.default];
              const other = second === '' ? undefined : option.labels[second];
              return (
                <tr key={option.code} className={CARD_TABLE.row}>
                  <td className={CARD_TABLE.cell}>
                    <span className="block font-medium wrap-anywhere text-fg">
                      {label ?? <span className="text-fg-muted">{t('values.no-label')}</span>}
                    </span>
                    <span className="block text-sm wrap-anywhere text-fg-muted">
                      {t('values.code', { code: option.code })}
                    </span>
                  </td>
                  {second === '' ? null : (
                    <td className={CARD_TABLE.labelled} data-label={columns[1]?.label}>
                      {other === undefined ? (
                        <span>
                          <Badge tone="attention">
                            {t('row.missing', { languages: languageName(second) })}
                          </Badge>
                        </span>
                      ) : (
                        <span lang={second} dir={directionOf(second)} className="wrap-anywhere">
                          {other}
                        </span>
                      )}
                    </td>
                  )}
                  <td className={CARD_TABLE.labelled} data-label={t('values.col.products')}>
                    <span className="tabular-nums">{option.productCount}</span>
                  </td>
                  <td className={CARD_TABLE.corner}>
                    <Badge tone={option.active ? 'success' : 'neutral'}>
                      {option.active ? t('values.active') : t('values.inactive')}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsedInTab({ detail }: { readonly detail: AttributeDetail }) {
  const t = useTranslations('attributes');
  return (
    <div className="flex flex-col gap-4">
      <DataList
        rows={[
          { label: t('used-in.products'), value: String(detail.productCount) },
          { label: t('used-in.feature-sets'), value: String(detail.usedIn.length) },
        ]}
        missing={t('none')}
      />
      {detail.usedIn.length === 0 ? (
        <p className="text-fg-muted">{t('used-in.empty')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {detail.usedIn.map((use) => (
            <li
              key={`${use.featureSetId}:${use.groupCode}`}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium wrap-anywhere text-fg">{use.featureSetCode}</span>
                <span className="text-sm wrap-anywhere text-fg-muted">
                  {t('used-in.group', { group: use.groupCode })}
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Badge tone={use.required ? 'info' : 'neutral'}>
                  {use.required ? t('used-in.required') : t('used-in.optional')}
                </Badge>
                {use.isVariantOption ? <Badge tone="info">{t('badge.variant')}</Badge> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryTab({ detail }: { readonly detail: AttributeDetail }) {
  const t = useTranslations('attributes');
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {detail.history.map((entry) => (
          <li key={entry.revisionNo} className="rounded-md border border-line p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="font-semibold text-fg">
                {t('history.revision', { number: entry.revisionNo })}
              </span>
              <span className="text-sm text-fg-muted">
                <When iso={entry.createdAt} missing={t('none')} />
              </span>
            </div>
            <p className="mt-1 text-sm text-fg-muted">
              {entry.authorKind === 'admin' && entry.authorAccountId !== null
                ? t('history.by-admin', { id: shortId(entry.authorAccountId) })
                : t(`author.${entry.authorKind}`)}
            </p>
            {entry.changes.length === 0 ? (
              <p className="mt-2 text-sm">{t('history.created')}</p>
            ) : (
              <ul className="mt-2 flex list-disc flex-col gap-1 ps-5 text-sm">
                {entry.changes.map((change) => (
                  <li key={change.field} className="wrap-anywhere">
                    <ChangeText change={change} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {detail.historyTruncated ? (
        <p className="text-sm text-fg-muted">{t('history.truncated')}</p>
      ) : null}
    </div>
  );
}

function ChangeText({ change }: { readonly change: AttributeChange }) {
  const t = useTranslations('attributes');
  const line = changeLineOf(change);
  const show = (value: AttributeChange['before']) => {
    if (value === null) return t('history.empty');
    if (typeof value === 'boolean') return value ? t('yes') : t('no');
    return String(value);
  };
  if (line.key === 'option-added') return <>{t('history.change.option-added', line)}</>;
  const what =
    line.key === 'other'
      ? line.field
      : line.key === 'bound'
        ? t('history.change.bound', { bound: t(`field.${boundKey(line.bound)}`) })
        : t(`history.change.${line.key}`, line);
  return (
    <>
      {t.rich('history.from-to', {
        what,
        before: show(change.before),
        after: show(change.after),
        // A value in another script keeps its own direction inside the English line.
        v: (chunks) => <bdi>{chunks}</bdi>,
      })}
    </>
  );
}

function boundKey(bound: string): 'max-length' | 'min' | 'max' | 'limit' {
  if (bound === 'maxLength') return 'max-length';
  if (bound === 'min' || bound === 'max') return bound;
  return 'limit';
}
