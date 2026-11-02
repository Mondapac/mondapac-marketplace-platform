'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  RadioGroup,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { problemOf } from './products-saved-save.tsx';
import { NAME_MAX, type SavedFilter, type Visibility } from './products-saved-types.ts';

type Mode = { readonly kind: 'edit' | 'delete'; readonly id: string } | null;

/**
 * One saved filter in the Manage filters list: its name and who can use it, and, when the admin
 * may manage it, Edit (name and, if the role can share, who can use it) and Delete (asked once, in
 * the row). A filter another admin shared, which this role cannot manage, is listed without
 * actions and says whose it is.
 */
function Row({
  filter,
  canShare,
  csrfToken,
  mode,
  onMode,
  onChanged,
  limits,
}: {
  readonly filter: SavedFilter;
  readonly canShare: boolean;
  readonly csrfToken: string;
  readonly mode: Mode;
  readonly onMode: (next: Mode) => void;
  readonly onChanged: () => void;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}) {
  const t = useTranslations('catalog.products.saved');
  const [name, setName] = useState(filter.name);
  const [visibility, setVisibility] = useState<Visibility>(filter.visibility);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof problemOf> | null>(null);
  const editing = mode?.id === filter.id && mode.kind === 'edit';
  const deleting = mode?.id === filter.id && mode.kind === 'delete';

  useEffect(() => {
    setName(filter.name);
    setVisibility(filter.visibility);
    setProblem(null);
  }, [filter.name, filter.visibility, mode]);

  async function save() {
    if (name.trim() === '') {
      setProblem('name-empty');
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await callApi<SavedFilter>(
      'PUT',
      `catalog/admin/saved-filters/${filter.id}`,
      { name: name.trim(), visibility },
      csrfToken,
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(problemOf(result.failure));
      return;
    }
    toast.success(t('toast.updated', { name: result.body.name }), { id: 'products-saved-filter' });
    onMode(null);
    onChanged();
  }

  async function remove() {
    setBusy(true);
    setProblem(null);
    const result = await callApi<{ id: string }>(
      'DELETE',
      `catalog/admin/saved-filters/${filter.id}`,
      undefined,
      csrfToken,
    );
    setBusy(false);
    // A filter already gone is what the admin wanted: say so and refresh the list.
    if (!result.ok && result.failure.code !== 'saved-filter.not-found') {
      setProblem(problemOf(result.failure));
      return;
    }
    toast.success(t('toast.deleted', { name: filter.name }), { id: 'products-saved-filter' });
    onMode(null);
    onChanged();
  }

  const nameProblem = problem === 'name-taken' || problem === 'name-empty' ? problem : null;
  const banner = problem !== null && nameProblem === null ? problem : null;
  const mayShare = canShare || filter.visibility === 'everyone';

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-fg [overflow-wrap:anywhere]">{filter.name}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone={filter.visibility === 'everyone' ? 'info' : 'neutral'}>
              {t(`visibility.${filter.visibility}`)}
            </Badge>
            {filter.ownedByMe ? null : <span>{t('manage.shared-by-other')}</span>}
          </div>
        </div>
        {filter.canManage && !editing && !deleting ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              aria-label={t('manage.edit-named', { name: filter.name })}
              onClick={() => onMode({ kind: 'edit', id: filter.id })}
            >
              {t('manage.edit')}
            </Button>
            <Button
              variant="destructive"
              aria-label={t('manage.delete-named', { name: filter.name })}
              onClick={() => onMode({ kind: 'delete', id: filter.id })}
            >
              {t('manage.delete')}
            </Button>
          </div>
        ) : null}
      </div>
      {banner === null ? null : (
        <Banner tone="critical">
          {t(`error.${banner}`, {
            max: banner === 'shared-limit' ? limits.shared : limits.perOwner,
          })}
        </Banner>
      )}
      {editing ? (
        <form
          className="flex flex-col gap-4 rounded-md border border-line bg-subtle p-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField
            label={t('save.name')}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            error={nameProblem === null ? undefined : t(`error.${nameProblem}`)}
            onChange={(event) => {
              setName(event.target.value);
              if (nameProblem !== null) setProblem(null);
            }}
          />
          {mayShare ? (
            <RadioGroup
              legend={t('save.who')}
              name={`products-saved-visibility-${filter.id}`}
              value={visibility}
              disabled={busy}
              options={[
                { value: 'me', label: t('visibility.me') },
                {
                  value: 'everyone',
                  label: t('visibility.everyone'),
                  help: t('save.everyone-help'),
                  disabled: !canShare && filter.visibility !== 'everyone',
                },
              ]}
              onChange={(value) => setVisibility(value as Visibility)}
            />
          ) : (
            <p className="text-sm text-fg-muted">{t('save.own-only')}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onMode(null)}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('manage.save')}
            </Button>
          </div>
        </form>
      ) : null}
      {deleting ? (
        <div
          role="group"
          aria-label={t('manage.delete-named', { name: filter.name })}
          className="flex flex-col gap-3 rounded-md border border-critical-border bg-critical-bg p-3"
        >
          <p className="text-sm text-fg [overflow-wrap:anywhere]">
            {t(filter.visibility === 'everyone' ? 'manage.delete-shared' : 'manage.delete-own', {
              name: filter.name,
            })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onMode(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" loading={busy} onClick={() => void remove()}>
              {t('manage.delete-confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The Manage filters dialog (Figma "Manage filters"): every saved view the admin can see, with
 * rename, who can use it and delete for the ones they may manage. Reordering is not offered (the
 * design shows none). Each change is a toast, and the page's tabs refresh.
 */
export function ManageFiltersDialog({
  open,
  onClose,
  filters,
  canShare,
  limits,
  csrfToken,
  onChanged,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly filters: readonly SavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
  readonly csrfToken: string;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('catalog.products.saved');
  const [mode, setMode] = useState<Mode>(null);

  useEffect(() => {
    if (!open) setMode(null);
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t('manage.title')}
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {t('manage.close')}
        </Button>
      }
    >
      {filters.length === 0 ? (
        <EmptyState
          size="compact"
          icon="sliders"
          title={t('manage.empty')}
          body={t('manage.empty-help')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">
            {canShare ? t('manage.help-share') : t('manage.help-own')}
          </p>
          <ul className="divide-y divide-line">
            {filters.map((filter) => (
              <Row
                key={filter.id}
                filter={filter}
                canShare={canShare}
                csrfToken={csrfToken}
                mode={mode}
                onMode={setMode}
                onChanged={onChanged}
                limits={limits}
              />
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
