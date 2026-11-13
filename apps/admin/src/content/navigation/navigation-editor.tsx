'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  FormActionBar,
  IconButton,
  Select,
  Switch,
  TextField,
  toast,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { formatInstantInZone } from '../../shared/format.ts';
import type { PageDetail } from '../pages/page-types.ts';
import { STALE_CODES, usePageCommand, useProblemText } from '../pages/use-page-command.ts';
import {
  LABEL_MAX,
  NAV_APPROVE_PATH,
  NAV_DRAFT_PATH,
  NAV_RESTORE_PATH,
  NAV_SLOTS,
  NAV_SLOT_MAX,
  TARGET_KINDS,
  blankItem,
  draftOf,
  errorKey,
  mapProblems,
  moved,
  requestOf,
  sameDraft,
  validate,
  type NavCode,
  type NavDraft,
  type NavErrors,
  type NavField,
  type NavItem,
  type NavSlot,
  type TargetKind,
} from './nav-form.ts';

interface Option {
  readonly value: string;
  readonly label: string;
}
interface Lookups {
  readonly categories: readonly Option[];
  readonly pages: readonly Option[];
  readonly systemPages: readonly Option[];
}
const NONE: Lookups = { categories: [], pages: [], systemPages: [] };

interface CategoryTree {
  readonly defaultLocale: string;
  readonly categories: readonly {
    readonly id: string;
    readonly status: string;
    readonly depth: number;
    readonly names: readonly { readonly locale: string; readonly name: string }[];
  }[];
}
interface PageList {
  readonly pages: readonly {
    readonly id: string | null;
    readonly kind: string;
    readonly systemKey: string | null;
    readonly title: string;
    readonly status: string;
    readonly editLevel: string;
  }[];
}

/**
 * The navigation of the buyer site: the left menu and the two Browse lists, edited as a local
 * draft and saved whole. Buyers see it only after a platform administrator approves it. Without
 * the edit key the lists are only shown.
 */
export function NavigationEditor({
  page: initial,
  canEdit,
  canApprove,
  csrfToken,
  zone,
}: {
  readonly page: PageDetail;
  readonly canEdit: boolean;
  readonly canApprove: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('content.navigation');
  const locale = useLocale();
  const router = useRouter();
  const problemText = useProblemText();
  const command = usePageCommand(csrfToken);
  const [page, setPage] = useState(initial);
  const [baseline, setBaseline] = useState<NavDraft>(() => draftOf(initial));
  const [draft, setDraft] = useState<NavDraft>(baseline);
  const [errors, setErrors] = useState<NavErrors>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [lookups, setLookups] = useState<Lookups>(NONE);
  const [dialog, setDialog] = useState<
    'approve' | { readonly restore: PageDetail['versions'][number] } | null
  >(null);

  const dirty = !sameDraft(draft, baseline);
  const guard = useUnsavedChangesGuard(dirty, {
    title: t('leave.title'),
    message: t('leave.message'),
    stay: t('leave.stay'),
    leave: t('leave.leave'),
    destructive: true,
  });
  const problem = command.problem;
  const stale =
    problem !== null &&
    (STALE_CODES.has(problem.code) ||
      problem.code === 'storefront.draft-changed' ||
      problem.code === 'storefront.version-not-found');

  // The lookups are a courtesy: without them (no permission, no connection) a row keeps what it
  // has and is shown by its id.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [tree, pages] = await Promise.all([
        callApi<CategoryTree>('GET', 'catalog/admin/categories'),
        callApi<PageList>('GET', 'storefront/admin/pages'),
      ]);
      if (!live) return;
      setLookups({
        categories: tree.ok
          ? tree.body.categories
              .filter((category) => category.status === 'active')
              .map((category) => {
                const name =
                  category.names.find((entry) => entry.locale === tree.body.defaultLocale) ??
                  category.names[0];
                return {
                  value: category.id,
                  label: `${'– '.repeat(category.depth)}${name?.name ?? category.id}`,
                };
              })
          : [],
        pages: pages.ok
          ? pages.body.pages
              .filter(
                (entry) =>
                  entry.kind === 'dynamic' && entry.id !== null && entry.status !== 'archived',
              )
              .map((entry) => ({ value: entry.id ?? '', label: entry.title }))
          : [],
        systemPages: pages.ok
          ? pages.body.pages
              .filter(
                (entry) =>
                  entry.kind === 'system' &&
                  entry.systemKey !== null &&
                  entry.systemKey !== 'navigation' &&
                  entry.editLevel !== 'navigation',
              )
              .map((entry) => ({ value: entry.systemKey ?? '', label: entry.title }))
          : [],
      });
    })();
    return () => {
      live = false;
    };
  }, []);

  const change = (slot: NavSlot, items: readonly NavItem[]) => {
    setDraft((current) => ({ ...current, [slot]: items }));
    setErrors({});
    setSummary(null);
  };
  const patch = (slot: NavSlot, index: number, next: Partial<NavItem>) =>
    change(
      slot,
      draft[slot].map((item, i) => (i === index ? { ...item, ...next } : item)),
    );

  async function save() {
    command.reset();
    const local = validate(draft);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setSummary(t('error.fields'));
      return;
    }
    const result = await command.run('PUT', NAV_DRAFT_PATH, requestOf(draft));
    if (result === null) return;
    if (!result.ok) {
      if (result.problem.code === 'validation.failed') {
        const mapped = mapProblems(result.problem.fields);
        setErrors(mapped.rows);
        setSummary(t('error.fields'));
      }
      return;
    }
    const next = draftOf(result.page);
    setPage(result.page);
    setBaseline(next);
    setDraft(next);
    setErrors({});
    setSummary(null);
    toast.success(t('saved'));
  }

  async function approve() {
    const result = await command.run('POST', NAV_APPROVE_PATH, {
      versionNo: page.draft.versionNo,
      updatedAt: page.draft.updatedAt,
    });
    if (result === null || !result.ok) return;
    toast.success(t('approved'));
    setDialog(null);
    router.refresh();
  }

  async function restore(id: string, versionNo: number) {
    const result = await command.run('POST', NAV_RESTORE_PATH, { versionId: id });
    if (result === null || !result.ok) return;
    toast.success(t('restored', { n: versionNo }));
    setDialog(null);
    router.refresh();
  }

  function close() {
    command.reset();
    setDialog(null);
  }

  const canApproveNow = canApprove && page.hasDraft && page.draft.versionNo !== null && !dirty;
  const versions = [...page.versions].sort((a, b) => b.versionNo - a.versionNo);

  return (
    <div className="flex flex-col gap-4">
      {guard.dialog}
      {canEdit ? null : <Banner tone="info">{t('read-only')}</Banner>}
      {problem !== null && dialog === null && problem.code !== 'validation.failed' ? (
        <Banner tone="critical">
          <span>{problemText(problem)}</span>
          {stale ? (
            <>
              {' '}
              <Button variant="link" onClick={() => router.refresh()}>
                {t('reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          {page.publishedVersionNo === null ? (
            <Badge tone="neutral">{t('never-approved')}</Badge>
          ) : (
            <Badge tone="success">{t('approved-version', { n: page.publishedVersionNo })}</Badge>
          )}
          {page.hasDraft ? <Badge tone="attention">{t('unapproved-changes')}</Badge> : null}
        </p>
        {canApprove ? (
          <div className="flex flex-col items-end gap-1">
            <Button
              disabled={!canApproveNow || command.pending}
              aria-describedby="nav-approve-hint"
              onClick={() => {
                command.reset();
                setDialog('approve');
              }}
            >
              {t('approve')}
            </Button>
            {canApproveNow ? null : (
              <p id="nav-approve-hint" className="text-sm text-fg-muted">
                {dirty ? t('approve-save-first') : t('nothing-to-approve')}
              </p>
            )}
          </div>
        ) : page.hasDraft ? (
          <p className="text-sm text-fg-muted">{t('waiting')}</p>
        ) : null}
      </div>
      {summary === null ? null : <Banner tone="critical">{summary}</Banner>}
      <form
        noValidate
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {NAV_SLOTS.map((slot) => (
          <SlotSection
            key={slot}
            slot={slot}
            items={draft[slot]}
            errors={errors}
            lookups={lookups}
            editable={canEdit}
            busy={command.pending}
            onAdd={() => change(slot, [...draft[slot], blankItem(slot)])}
            onPatch={(index, next) => patch(slot, index, next)}
            onMove={(index, by) => change(slot, moved(draft[slot], index, by))}
            onRemove={(index) =>
              change(
                slot,
                draft[slot].filter((_, i) => i !== index),
              )
            }
          />
        ))}
        {canEdit ? (
          <FormActionBar status={<span className="block">{t('draft-note')}</span>}>
            <Button
              variant="secondary"
              disabled={!dirty || command.pending}
              onClick={() => {
                setDraft(baseline);
                setErrors({});
                setSummary(null);
                command.reset();
              }}
            >
              {t('discard')}
            </Button>
            <Button type="submit" loading={command.pending} disabled={!dirty}>
              {t('save-draft')}
            </Button>
          </FormActionBar>
        ) : null}
      </form>
      <Card title={t('versions')}>
        {versions.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('versions-empty')}</p>
        ) : (
          <ol aria-label={t('versions')} className="m-0 flex list-none flex-col gap-2 p-0">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('version', { n: version.versionNo })}</span>
                  <Badge
                    tone={
                      version.state === 'draft'
                        ? 'attention'
                        : version.state === 'published'
                          ? 'success'
                          : 'neutral'
                    }
                  >
                    {t(
                      version.state === 'draft' || version.state === 'published'
                        ? `state-${version.state}`
                        : 'state-earlier',
                    )}
                  </Badge>
                  <span className="text-sm text-fg-muted">
                    {formatInstantInZone(version.publishedAt ?? version.createdAt, locale, zone)}
                  </span>
                </span>
                {canEdit && version.state !== 'draft' ? (
                  <Button
                    variant="secondary"
                    aria-label={t('restore-label', { n: version.versionNo })}
                    disabled={command.pending}
                    onClick={() => {
                      command.reset();
                      setDialog({ restore: version });
                    }}
                  >
                    {t('restore')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Card>
      {dialog === null ? null : (
        <Dialog
          open
          title={
            dialog === 'approve'
              ? t('approve-title')
              : t('restore-title', { n: dialog.restore.versionNo })
          }
          onClose={close}
          actions={
            <>
              <Button variant="secondary" onClick={close}>
                {t('cancel')}
              </Button>
              {stale ? (
                <Button
                  onClick={() => {
                    close();
                    router.refresh();
                  }}
                >
                  {t('reload')}
                </Button>
              ) : (
                <Button
                  loading={command.pending}
                  onClick={() =>
                    void (dialog === 'approve'
                      ? approve()
                      : restore(dialog.restore.id, dialog.restore.versionNo))
                  }
                >
                  {dialog === 'approve' ? t('approve-confirm') : t('restore-confirm')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {problem === null ? null : (
              <Banner tone="critical">
                {problem.code === 'storefront.nothing-to-publish'
                  ? t('error.nothing')
                  : problem.code === 'storefront.draft-changed'
                    ? t('error.changed')
                    : problem.code === 'storefront.version-not-found'
                      ? t('error.gone')
                      : problemText(problem)}
              </Banner>
            )}
            <p>{dialog === 'approve' ? t('approve-body') : t('restore-body')}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function SlotSection({
  slot,
  items,
  errors,
  lookups,
  editable,
  busy,
  onAdd,
  onPatch,
  onMove,
  onRemove,
}: {
  readonly slot: NavSlot;
  readonly items: readonly NavItem[];
  readonly errors: NavErrors;
  readonly lookups: Lookups;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly onPatch: (index: number, next: Partial<NavItem>) => void;
  readonly onMove: (index: number, by: -1 | 1) => void;
  readonly onRemove: (index: number) => void;
}) {
  const t = useTranslations('content.navigation');
  const max = NAV_SLOT_MAX[slot];
  const full = items.length >= max;
  return (
    <section
      aria-label={t(`slot.${slot}`)}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t(`slot.${slot}`)}</h2>
          <p className="text-sm text-fg-muted">
            {t(`slot-help.${slot}`)} {t('count', { count: items.length, max })}
          </p>
        </div>
        {editable ? (
          <Button
            variant="secondary"
            aria-label={t('add-to', { slot: t(`slot.${slot}`) })}
            disabled={full || busy}
            onClick={onAdd}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {slot === 'rail' ? (
        <p className="rounded-md border border-dashed border-line px-3 py-2 text-sm text-fg-muted">
          {t('browse-locked')}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {slot === 'drawer-categories' ? t('empty-categories') : t('empty')}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item, index) => (
            <NavRow
              key={item.key}
              slot={slot}
              item={item}
              index={index}
              count={items.length}
              errors={errors}
              lookups={lookups}
              editable={editable}
              busy={busy}
              onPatch={(next) => onPatch(index, next)}
              onMove={(by) => onMove(index, by)}
              onRemove={() => onRemove(index)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function NavRow({
  slot,
  item,
  index,
  count,
  errors,
  lookups,
  editable,
  busy,
  onPatch,
  onMove,
  onRemove,
}: {
  readonly slot: NavSlot;
  readonly item: NavItem;
  readonly index: number;
  readonly count: number;
  readonly errors: NavErrors;
  readonly lookups: Lookups;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onPatch: (next: Partial<NavItem>) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('content.navigation');
  const n = index + 1;
  const codeText = (code: NavCode | undefined): string | undefined =>
    code === undefined
      ? undefined
      : code === 'too-long'
        ? t('error.too-long', { max: LABEL_MAX })
        : t(`error.${code}`);
  const err = (field: NavField) => codeText(errors[errorKey(slot, index, field)]);
  // A value the lookups do not know (a removed category, no permission) is kept and shown by id.
  const withCurrent = (options: readonly Option[], value: string): Option[] =>
    value === '' || options.some((option) => option.value === value)
      ? [...options]
      : [{ value, label: value }, ...options];
  const rail = slot === 'rail';
  const targetOptions =
    item.kind === 'category'
      ? withCurrent(lookups.categories, item.value)
      : item.kind === 'page'
        ? withCurrent(lookups.pages, item.value)
        : withCurrent(lookups.systemPages, item.value);
  const name = item.label.trim() === '' ? t('row', { n }) : item.label.trim();
  return (
    <li
      className={`flex min-w-0 flex-col gap-3 rounded-md border border-line p-3 ${
        item.enabled ? 'bg-surface' : 'bg-muted/60'
      }`}
    >
      <fieldset disabled={!editable || busy} className="m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">{t('row', { n })}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {rail ? (
            <>
              <TextField
                label={t('label')}
                value={item.label}
                autoComplete="off"
                error={err('label')}
                help={t('label-help', { max: LABEL_MAX })}
                onChange={(event) => onPatch({ label: event.target.value })}
              />
              <TextField
                label={t('icon')}
                value={item.icon}
                autoComplete="off"
                error={err('icon')}
                help={t('icon-help')}
                onChange={(event) => onPatch({ icon: event.target.value })}
              />
              <Select
                label={t('link-to')}
                value={item.kind}
                options={TARGET_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))}
                onChange={(event) => onPatch({ kind: event.target.value as TargetKind, value: '' })}
              />
              {item.kind === 'path' ? (
                <TextField
                  label={t('path')}
                  value={item.value}
                  autoComplete="off"
                  placeholder="/offers"
                  error={err('value')}
                  help={t('path-help')}
                  onChange={(event) => onPatch({ value: event.target.value })}
                />
              ) : (
                <Select
                  label={t(`kind.${item.kind}`)}
                  value={item.value}
                  placeholder={t('choose')}
                  options={targetOptions}
                  error={err('value')}
                  onChange={(event) => onPatch({ value: event.target.value })}
                />
              )}
            </>
          ) : (
            <>
              <Select
                label={t('category')}
                value={item.categoryId}
                placeholder={t('choose')}
                options={withCurrent(lookups.categories, item.categoryId)}
                error={err('categoryId')}
                onChange={(event) => onPatch({ categoryId: event.target.value })}
              />
              <TextField
                label={t('label-optional')}
                value={item.label}
                autoComplete="off"
                error={err('label')}
                help={t('label-name-help', { max: LABEL_MAX })}
                onChange={(event) => onPatch({ label: event.target.value })}
              />
            </>
          )}
        </div>
      </fieldset>
      {editable ? (
        <div className="flex flex-wrap items-center justify-end gap-1">
          <IconButton
            icon="chevron-up"
            label={t('up', { name })}
            disabled={busy || index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="chevron-down"
            label={t('down', { name })}
            disabled={busy || index === count - 1}
            onClick={() => onMove(1)}
          />
          <Switch
            checked={item.enabled}
            disabled={busy}
            className="relative after:absolute after:-inset-2.5 after:content-['']"
            aria-label={t('show-switch', { name })}
            onCheckedChange={(checked) => onPatch({ enabled: checked })}
          />
          <Button
            variant="secondary"
            aria-label={t('remove-row', { name })}
            disabled={busy}
            onClick={onRemove}
          >
            {t('remove')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
