'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { messageKeyOf, REFRESH_CODES } from './submit-errors.ts';

/** D3: withdraw the pending submission. The draft stays as it is (sellers ux 3.4). */
export function WithdrawSubmission({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  function close() {
    if (busy.current) return;
    setOpen(false);
    setProblem(null);
  }

  async function withdraw() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi('POST', 'sellers/my-file/withdraw', {}, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (REFRESH_CODES.has(failure.code)) {
      setOpen(false);
      router.refresh();
      return;
    }
    setProblem(messageKeyOf(failure));
  }

  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('sellers.withdraw.open')}
      </Button>
      <Dialog
        open={open}
        title={t('sellers.withdraw.title')}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={pending}>
              {t('sellers.withdraw.keep')}
            </Button>
            <Button loading={pending} onClick={() => void withdraw()}>
              {t('sellers.withdraw.action')}
            </Button>
          </>
        }
      >
        <p>{t('sellers.withdraw.body')}</p>
        {problem === null ? null : (
          <div className="mt-4">
            <Banner tone="critical">{t(problem)}</Banner>
          </div>
        )}
      </Dialog>
    </div>
  );
}
