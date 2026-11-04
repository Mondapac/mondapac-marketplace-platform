'use client';

import { Banner, Button, Dialog, RadioGroup, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import {
  LIST_KEY,
  NAME_MAX,
  payloadOf,
  type SavedFilter,
  type Visibility,
} from './products-saved-types.ts';
import type { Query } from './products-types.ts';

type Problem = 'name-taken' | 'name-empty' | 'limit' | 'shared-limit' | 'denied' | 'unavailable';

/** What a refused save says, in the key of the message (one per cause). */
export function problemOf(failure: ApiFailure): Problem {
  if (failure.code === 'saved-filter.name-taken') return 'name-taken';
  if (failure.code === 'saved-filter.limit-reached') return 'limit';
  if (failure.code === 'saved-filter.shared-limit-reached') return 'shared-limit';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    return failure.details?.fields?.some((field) => field.path === 'name')
      ? 'name-empty'
      : 'unavailable';
  }
  return 'unavailable';
}

/**
 * The Save filter dialog (Figma "Save filter"): a name and who can use the filter, over a one-line
 * summary of what is saved. An admin whose role holds `catalog.saved-filter.share` chooses Only me
 * or Everyone; any other admin sees that the filter is saved for them only. Enter saves; a name
 * that is empty, repeated or too long is said under the field, any other refusal in a banner.
 */
export function SaveFilterDialog({
  open,
  onClose,
  query,
  summary,
  canShare,
  limits,
  csrfToken,
  onSaved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly query: Query;
  /** What the filter holds, in words: the tab, the search and each condition. */
  readonly summary: string;
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
  readonly csrfToken: string;
  readonly onSaved: (filter: SavedFilter) => void;
}) {
  const t = useTranslations('catalog.products.saved');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('me');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setVisibility('me');
    setBusy(false);
    setProblem(null);
  }, [open]);

  async function save() {
    if (busy) return;
    if (name.trim() === '') {
      setProblem('name-empty');
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await callApi<SavedFilter>(
      'POST',
      'catalog/admin/saved-filters',
      {
        listKey: LIST_KEY,
        name: name.trim(),
        visibility: canShare ? visibility : 'me',
        payload: payloadOf(query),
      },
      csrfToken,
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(problemOf(result.failure));
      return;
    }
    toast.success(t('toast.saved', { name: result.body.name }), { id: 'products-saved-filter' });
    onSaved(result.body);
    onClose();
  }

  const nameProblem = problem === 'name-taken' || problem === 'name-empty' ? problem : null;
  const banner = problem !== null && nameProblem === null ? problem : null;

  return (
    <Dialog
      open={open}
      title={t('save.title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="products-save-filter" loading={busy}>
            {t('save.submit')}
          </Button>
        </>
      }
    >
      <form
        id="products-save-filter"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-fg-secondary [overflow-wrap:anywhere]">{summary}</p>
        {banner === null ? null : (
          <Banner tone="critical">
            {t(`error.${banner}`, {
              max: banner === 'shared-limit' ? limits.shared : limits.perOwner,
            })}
          </Banner>
        )}
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
        {canShare ? (
          <RadioGroup
            legend={t('save.who')}
            name="products-saved-visibility"
            value={visibility}
            disabled={busy}
            options={[
              { value: 'me', label: t('visibility.me') },
              { value: 'everyone', label: t('visibility.everyone'), help: t('save.everyone-help') },
            ]}
            onChange={(value) => setVisibility(value as Visibility)}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-fg">{t('save.who')}</p>
            <p className="text-sm text-fg-muted">{t('save.own-only')}</p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
