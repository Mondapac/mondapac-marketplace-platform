'use client';

import {
  Badge,
  Banner,
  Button,
  DataList,
  Dialog,
  EmptyState,
  LoadError,
  SearchSelect,
  SkeletonRows,
  Tabs,
  toast,
  type DataListRow,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import { AttributeEditForm } from './attribute-edit-form.tsx';
import { BASE_UNIT, type FieldErrors } from './editor.ts';
import { changeLineOf } from './history.ts';
import { useRevealWhenStacked } from './reveal.ts';
import { useSelectLabels } from './select-labels.ts';
import { useAttributeCall } from './use-attribute-call.ts';
import {
  API_ATTRIBUTES,
  CHOICE_TYPES,
  DETAIL_TABS,
  directionOf,
  languageName,
  textIn,
  type AttributeChange,
  type AttributeDetail,
  type AttributeWrite,
  type DetailTab,
} from './types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly detail: AttributeDetail }
  | { readonly state: 'missing' }
  | { readonly state: 'failed' };

type Confirm = 'publish' | 'discard' | null;

/** Refusals of publish that only an edit of the text clears. */
const TEXT_FIX: ReadonlySet<string> = new Set(['claim-word', 'locale-uncheckable']);

/**
 * One attribute (plan 16): its name and badges, then four sub-tabs. Details shows the name in a
 * chosen language and the settings; Values lists the options with their product counts and, on
 * request, a second language next to the default; Used in lists the feature sets; History lists
 * the revisions newest first with what changed. An admin with `catalog.attribute.edit` also edits
 * it, and publishes or discards a draft (attributes A2).
 */
export function AttributeDetailPanel({
  attributeId,
  onClose,
  canEdit = false,
  csrfToken = '',
  onChanged,
}: {
  readonly attributeId: string | null;
  readonly onClose: () => void;
  readonly canEdit?: boolean;
  readonly csrfToken?: string;
  /** An attribute was saved, published or discarded: the list reads it again. */
  readonly onChanged?: () => void;
}) {
  const t = useTranslations('attributes.detail');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [tab, setTab] = useState<DetailTab>('details');
  const [editing, setEditing] = useState(false);
  const [editErrors, setEditErrors] = useState<FieldErrors | undefined>(undefined);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const latest = useRef(0);
  const panel = useRef<HTMLElement>(null);
  useRevealWhenStacked(panel, attributeId, load.state === 'ready');

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
    setEditing(false);
    setConfirm(null);
    void fetchDetail();
  }, [fetchDetail]);

  const changed = (message: string) => {
    toast.success(message);
    setEditing(false);
    setEditErrors(undefined);
    setConfirm(null);
    onChanged?.();
    void fetchDetail();
  };

  if (attributeId === null) {
    return <EmptyState size="card" icon="sliders" title={t('none')} body={t('none-body')} />;
  }

  return (
    <section
      ref={panel}
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
          <Header
            detail={load.detail}
            onClose={onClose}
            actions={
              canEdit && !editing && load.detail.status !== 'archived' ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditErrors(undefined);
                      setEditing(true);
                    }}
                  >
                    {t('edit')}
                  </Button>
                  {load.detail.status === 'draft' ? (
                    <>
                      <Button onClick={() => setConfirm('publish')}>{t('publish')}</Button>
                      <Button variant="destructive" onClick={() => setConfirm('discard')}>
                        {t('discard')}
                      </Button>
                    </>
                  ) : null}
                </>
              ) : null
            }
          />
          {load.detail.status === 'draft' ? <Banner tone="info">{t('draft-note')}</Banner> : null}
          {confirm === null ? null : (
            <StatusDialog
              kind={confirm}
              detail={load.detail}
              csrfToken={csrfToken}
              onClose={() => setConfirm(null)}
              onDone={() => changed(t(confirm === 'publish' ? 'published' : 'discarded'))}
              onReload={() => {
                setConfirm(null);
                void fetchDetail();
              }}
              onEdit={(fields) => {
                setConfirm(null);
                setEditErrors(fields);
                setEditing(true);
              }}
            />
          )}
          {editing ? (
            <AttributeEditForm
              detail={load.detail}
              csrfToken={csrfToken}
              initialErrors={editErrors}
              onCancel={() => setEditing(false)}
              onSaved={() => changed(t('saved'))}
              onReload={() => {
                setEditing(false);
                void fetchDetail();
              }}
            />
          ) : (
            <>
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
          )}
        </>
      ) : null}
    </section>
  );
}

function Header({
  detail,
  onClose,
  actions,
}: {
  readonly detail: AttributeDetail;
  readonly onClose: () => void;
  readonly actions: ReactNode;
}) {
  const t = useTranslations('attributes');
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 tabIndex={-1} className="text-lg font-semibold wrap-anywhere text-fg">
            {name}
          </h2>
          <Badge
            tone={
              detail.status === 'active'
                ? 'success'
                : detail.status === 'draft'
                  ? 'attention'
                  : 'neutral'
            }
          >
            {t(`status.${detail.status}`)}
          </Badge>
          {detail.material ? <Badge tone="attention">{t('badge.material')}</Badge> : null}
          {detail.isVariantOption ? <Badge tone="info">{t('badge.variant')}</Badge> : null}
        </div>
        <p className="text-sm wrap-anywhere text-fg-muted">
          {detail.code} · {t(`type.${detail.dataType}`)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {actions}
        <Button variant="secondary" onClick={onClose}>
          {t('detail.close')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Publish or discard a draft, after the admin confirms. Publishing makes it visible to sellers
 * wherever a feature set names it, and runs the claim check again; discarding archives a draft
 * that was never published.
 */
function StatusDialog({
  kind,
  detail,
  csrfToken,
  onClose,
  onDone,
  onReload,
  onEdit,
}: {
  readonly kind: 'publish' | 'discard';
  readonly detail: AttributeDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
  /** The text must change first (a claim word): open the editor on the refused fields. */
  readonly onEdit: (fields: FieldErrors) => void;
}) {
  const t = useTranslations('attributes.detail');
  const te = useTranslations('attributes.editor');
  const call = useAttributeCall(csrfToken);
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  const missing = detail.missingLocales.map((tag) => languageName(tag, detail.locales.supported));

  async function confirm() {
    const answer = await call.run<AttributeWrite>(
      'POST',
      `${API_ATTRIBUTES}/${encodeURIComponent(detail.id)}/${kind}`,
      { version: detail.version },
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t(`${kind}-title`, { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {te('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{te('reload')}</Button>
          ) : problem !== null && TEXT_FIX.has(problem.key) ? (
            <Button onClick={() => onEdit(problem.fields)}>{t('edit-attribute')}</Button>
          ) : (
            <Button
              variant={kind === 'discard' ? 'destructive-solid' : 'primary'}
              loading={call.pending}
              disabled={call.pending}
              onClick={() => void confirm()}
            >
              {t(kind)}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : (
          <Banner tone="critical">
            {TEXT_FIX.has(problem.key) ? t(`publish-${problem.key}`) : te(`error.${problem.key}`)}
          </Banner>
        )}
        <p>{t(`${kind}-body`)}</p>
        {kind === 'publish' && missing.length > 0 ? (
          <p className="text-sm text-fg-muted">
            {t('publish-missing', { languages: missing.join(', ') })}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** A unit's label in the Market's main language, else its code. */
function unitLabel(detail: AttributeDetail, code: string): string {
  return textIn(
    detail.units.find((unit) => unit.code === code)?.labels,
    detail.locales.default,
    detail.locales.default,
    code,
  );
}

/** The base unit after a measure's lowest or highest value (they are stored in base units). */
function baseSuffix(detail: AttributeDetail): string {
  const measure = detail.bounds.measure;
  const base = measure === undefined ? undefined : BASE_UNIT[measure.dimension];
  return base === undefined ? '' : ` ${unitLabel(detail, base)}`;
}

/** The unit settings of a measure attribute (attributes A3), as rows of the Details tab. */
function measureRows(
  detail: AttributeDetail,
  t: ReturnType<typeof useTranslations>,
): DataListRow[] {
  const measure = detail.bounds.measure;
  if (measure === undefined) return [];
  return [
    {
      label: t('field.measure-dimension'),
      value: t(`editor.measure.dimension.${measure.dimension}`),
    },
    {
      label: t('field.measure-units'),
      value: measure.units.map((code) => unitLabel(detail, code)).join(', '),
    },
    { label: t('field.measure-default-unit'), value: unitLabel(detail, measure.defaultUnit) },
    { label: t('field.measure-decimals'), value: String(measure.decimals) },
  ];
}

function DetailsTab({ detail }: { readonly detail: AttributeDetail }) {
  const t = useTranslations('attributes');
  const selectLabels = useSelectLabels();
  const { locales } = detail;
  const [locale, setLocale] = useState(locales.default);
  const options: readonly SearchSelectOption[] = locales.supported.map((tag) => ({
    value: tag,
    label: languageName(tag, locales.supported),
    description: tag,
  }));
  const picked = options.find((option) => option.value === locale) ?? null;
  const name = detail.names[locale];
  const language = languageName(locale, locales.supported);
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
      : [{ label: t('field.min'), value: `${detail.bounds.min}${baseSuffix(detail)}` }]),
    ...(detail.bounds.max === undefined
      ? []
      : [{ label: t('field.max'), value: `${detail.bounds.max}${baseSuffix(detail)}` }]),
    ...measureRows(detail, t),
    { label: t('field.show-on-product-page'), value: yesNo(detail.display.showOnProductPage) },
    { label: t('field.searchable'), value: yesNo(detail.display.searchable) },
    { label: t('field.can-be-filter'), value: yesNo(detail.display.canBeFilter) },
    { label: t('field.position'), value: String(detail.display.position) },
    ...(detail.display.internalNote === null
      ? []
      : [
          {
            label: t('field.internal-note'),
            value: <span className="wrap-anywhere">{detail.display.internalNote}</span>,
          },
        ]),
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
        {detail.display.helpText[locale] === undefined ? null : (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-fg-muted">{t('field.help-text')}</span>
            <span lang={locale} dir={directionOf(locale)} className="wrap-anywhere text-fg">
              {detail.display.helpText[locale]}
            </span>
          </div>
        )}
        {detail.missingLocales.length > 0 ? (
          <p className="text-sm text-fg-muted">
            {t('detail.missing-anywhere', {
              languages: detail.missingLocales
                .map((tag) => languageName(tag, locales.supported))
                .join(', '),
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
  const selectLabels = useSelectLabels();
  const { locales } = detail;
  const [second, setSecond] = useState('');
  if (!CHOICE_TYPES.has(detail.dataType)) {
    return <EmptyState size="compact" icon="sliders" title={t('values.not-choice')} />;
  }
  if (detail.options.length === 0) {
    return <EmptyState size="compact" icon="sliders" title={t('values.empty')} />;
  }
  const nameOf = (locale: string) => languageName(locale, locales.supported);
  const others: readonly SearchSelectOption[] = locales.supported
    .filter((locale) => locale !== locales.default)
    .map((locale) => ({ value: locale, label: nameOf(locale) }));
  const defaultLanguage = nameOf(locales.default);
  return (
    <div className="flex flex-col gap-3">
      {others.length > 0 ? (
        <div className="max-w-xs">
          <SearchSelect
            label={t('values.second', { language: defaultLanguage })}
            placeholder={t('values.second-none')}
            options={others}
            value={others.find((option) => option.value === second) ?? null}
            labels={selectLabels}
            clearLabel={t('values.second-clear')}
            onChange={(option) => setSecond(option?.value ?? '')}
          />
        </div>
      ) : null}
      {/* A list, not a table: the panel is half the page wide, so columns would not fit. */}
      <ul
        aria-label={t('detail.tab.values')}
        className="divide-y divide-line rounded-md border border-line"
      >
        {detail.options.map((option) => {
          const label = option.labels[locales.default];
          const other = second === '' ? undefined : option.labels[second];
          return (
            <li
              key={option.code}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium wrap-anywhere text-fg">
                  {label ?? <span className="text-fg-muted">{t('values.no-label')}</span>}
                </span>
                {second === '' ? null : (
                  <span className="text-sm">
                    <span className="text-fg-muted">{nameOf(second)}: </span>
                    {other === undefined ? (
                      <Badge tone="attention">{t('values.missing')}</Badge>
                    ) : (
                      <bdi lang={second} dir={directionOf(second)} className="wrap-anywhere">
                        {other}
                      </bdi>
                    )}
                  </span>
                )}
                <span className="text-sm wrap-anywhere text-fg-muted">
                  {t('values.code', { code: option.code })}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <Badge tone={option.active ? 'success' : 'neutral'}>
                  {option.active ? t('values.active') : t('values.inactive')}
                </Badge>
                <span className="text-sm whitespace-nowrap text-fg-muted">
                  {t('row.products', { count: option.productCount })}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
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
        <EmptyState size="compact" icon="columns" title={t('used-in.empty')} />
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
  const { locales } = detail;
  const labels = new Map(
    detail.options.map((option) => [
      option.code,
      textIn(option.labels, locales.default, locales.default, option.code),
    ]),
  );
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
                    <ChangeText
                      change={change}
                      supported={locales.supported}
                      labelOf={(code) => labels.get(code) ?? code}
                    />
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

function ChangeText({
  change,
  supported,
  labelOf,
}: {
  readonly change: AttributeChange;
  readonly supported: readonly string[];
  readonly labelOf: (code: string) => string;
}) {
  const t = useTranslations('attributes');
  const line = changeLineOf(change, supported);
  const show = (value: AttributeChange['before']) => {
    if (value === null) return t('history.empty');
    if (typeof value === 'boolean') {
      if (line.key === 'option-active') return value ? t('values.active') : t('values.inactive');
      return value ? t('yes') : t('no');
    }
    return String(value);
  };
  if (line.key === 'internal-note') return <>{t('history.change.internal-note')}</>;
  if (line.key === 'option-added' || line.key === 'option-removed') {
    return <>{t(`history.change.${line.key}`, { value: labelOf(line.code) })}</>;
  }
  let what: string;
  switch (line.key) {
    case 'other':
      what = line.field;
      break;
    case 'bound':
      what = t('history.change.bound', { bound: t(`field.${boundKey(line.bound)}`) });
      break;
    case 'measure':
      what = t('history.change.measure', {
        setting: t(`field.measure-${measureKey(line.setting)}`),
      });
      break;
    case 'name':
      what = t('history.change.name', { language: line.language });
      break;
    case 'help':
      what = t('history.change.help', { language: line.language });
      break;
    case 'option-label':
      what = t('history.change.option-label', {
        value: labelOf(line.code),
        language: line.language,
      });
      break;
    case 'option-active':
    case 'option-position':
      what = t(`history.change.${line.key}`, { value: labelOf(line.code) });
      break;
    default:
      what = t(`history.change.${line.key}`);
  }
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

function measureKey(setting: string): 'dimension' | 'units' | 'default-unit' | 'decimals' {
  if (setting === 'defaultUnit') return 'default-unit';
  if (setting === 'dimension' || setting === 'units' || setting === 'decimals') return setting;
  return 'units';
}

function boundKey(bound: string): 'max-length' | 'min' | 'max' | 'limit' {
  if (bound === 'maxLength') return 'max-length';
  if (bound === 'min' || bound === 'max') return bound;
  return 'limit';
}
