'use client';

import { Banner, Button, Card, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
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
 */
export function ShelfPicker({
  offerId,
  version,
  shelves,
  csrfToken,
}: {
  readonly offerId: string;
  readonly version: number;
  readonly shelves: readonly ShelfChoice[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('categories.shelf');
  const [choice, setChoice] = useState('');
  const [current, setCurrent] = useState(version);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'set' | 'cleared' | null>(null);
  const busy = useRef(false);

  async function save() {
    if (busy.current || choice === '') return;
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
      setSaved(choice === NO_SHELF ? 'cleared' : 'set');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(shelfProblemOf(result.failure));
  }

  return (
    <Card title={t('title')}>
      <form
        className="flex max-w-(--mp-size-form-max) flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
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
        <div>
          <Button type="submit" loading={pending} disabled={pending || choice === ''}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
