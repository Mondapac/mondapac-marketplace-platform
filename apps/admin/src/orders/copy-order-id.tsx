'use client';

import { Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/** Copies the order id for a support ticket; says so, or says it could not. */
export function CopyOrderId({ orderId }: { readonly orderId: string }) {
  const t = useTranslations('orders.detail');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(orderId);
      setState('copied');
    } catch {
      setState('failed');
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => void copy()}>
        {t('copy-id')}
      </Button>
      <span role="status" className="text-sm text-fg-muted">
        {state === 'copied' ? t('copied') : state === 'failed' ? t('copy-failed') : ''}
      </span>
    </div>
  );
}
