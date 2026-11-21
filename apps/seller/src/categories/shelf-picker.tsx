'use client';

import { Banner, Card, SaveBar, Select, useUnsavedChangesGuard } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { shelfProblemOf } from './logic.ts';

const NO_SHELF = '__none';

export interface ShelfChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * Puts an Offer on one of the seller's active shelves, or takes it off (`PUT offers/:id/shelf`).
 * A shelf groups Offers on the shop page only; it changes no category, badge or filter. The Offer
 * read does not say which shelf the Offer is on now, so the picker starts with no choice made.
 * A choice not yet saved shows the shared save bar. The cards after the picker on the page are
 * passed as `children` so the bar's form spans them and the bar stays at the bottom of the screen.
 */
export function ShelfPicker({
  offerId,
  version,
  shelves,
  csrfToken,
  children,
}: {
  readonly offerId: string;
  readonly version: number;
  readonly shelves: readonly ShelfChoice[];
  readonly csrfToken: string;
  readonly children?: ReactNode;
}) {
  const t = useTranslations('categories.shelf');
  const tr = useTranslations();
  const [choice, setChoice] = useState('');
  // The choice last saved here: choosing it again is not a change.
  const [savedChoice, setSavedChoice] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [current, setCurrent] = useState(version);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'set' | 'cleared' | null>(null);
  const busy = useRef(false);
  const dirty = choice !== '' && choice !== savedChoice;
  const guard = useUnsavedChangesGuard(
    dirty && !leaving,
    {
      title: tr('settings.leave.title'),
      message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
      stay: tr('settings.leave.stay'),
      leave: tr('settings.leave.leave'),
    },
    { count: 1, page: t('title') },
  );

  async function save() {
    if (busy.current || !dirty) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setSaved(null);
    const result = await callApi<{ version: number }>(
      'PUT',
      `catalog/seller/offers/${offerId}/shelf`,
      { shelfId: choice === NO_SHELF ? null : choice, version: current },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setCurrent(result.body.version);
      setSavedChoice(choice);
      setSaved(choice === NO_SHELF ? 'cleared' : 'set');
      return;
    }
    if (result.failure.status === 401) {
      flushSync(() => setLeaving(true));
      window.location.assign('/session-ended');
      return;
    }
    setError(shelfProblemOf(result.failure));
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Card title={t('title')}>
        <div className="flex max-w-(--mp-size-form-max) flex-col gap-4">
          {error === null ? null : <Banner tone="critical">{t(`error.${error}`)}</Banner>}
          {saved === null ? null : <Banner tone="success">{t(`saved.${saved}`)}</Banner>}
          <Select
            name="shelfId"
            label={t('label')}
            help={t('help')}
            placeholder={t('placeholder')}
            options={[
              ...shelves.map((shelf) => ({ value: shelf.id, label: shelf.name })),
              { value: NO_SHELF, label: t('none') },
            ]}
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
              setSaved(null);
            }}
          />
        </div>
      </Card>
      {children}
      <SaveBar
        count={dirty ? 1 : 0}
        summary={tr('settings.bar.summary', { count: 1 })}
        saving={pending}
        aboveBottomBar
        labels={{
          region: tr('settings.bar.region'),
          discard: tr('settings.bar.discard'),
          save: t('save'),
          saving: t('save'),
        }}
        onDiscard={() => {
          setChoice(savedChoice);
          setError(null);
        }}
      />
      {dirty ? guard.dialog : null}
    </form>
  );
}
