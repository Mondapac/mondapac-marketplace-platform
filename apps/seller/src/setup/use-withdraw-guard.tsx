'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';

/**
 * While a submission waits for review, saving a changed step withdraws it (sellers ux F14). This
 * shows the warning banner, and asks first when the page has a change to save (D3). An unchanged
 * page saves without asking.
 */
export function useWithdrawGuard(awaitingReview: boolean): {
  readonly banner: ReactNode;
  readonly dialog: ReactNode;
  readonly run: (changed: boolean, persist: () => Promise<void>) => Promise<void>;
} {
  const t = useTranslations('sellers.edit-warning');
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => Promise<void>) | null>(null);

  async function run(changed: boolean, persist: () => Promise<void>) {
    if (!awaitingReview || !changed) {
      await persist();
      return;
    }
    pending.current = persist;
    setOpen(true);
  }

  async function confirm() {
    const persist = pending.current;
    pending.current = null;
    setOpen(false);
    if (persist !== null) await persist();
  }

  function keep() {
    pending.current = null;
    setOpen(false);
  }

  return {
    banner: awaitingReview ? <Banner tone="attention">{t('banner')}</Banner> : null,
    dialog: (
      <Dialog
        open={open}
        title={t('title')}
        onClose={keep}
        actions={
          <>
            <Button variant="secondary" onClick={keep}>
              {t('keep')}
            </Button>
            <Button onClick={() => void confirm()}>{t('action')}</Button>
          </>
        }
      >
        <p>{t('body')}</p>
      </Dialog>
    ),
    run,
  };
}
