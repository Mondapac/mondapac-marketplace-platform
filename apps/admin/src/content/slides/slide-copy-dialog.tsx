'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { copyPath, type SlideCopyPackage } from './slide-types.ts';

type Load = 'loading' | 'ready' | 'failed';

/**
 * Copy to another Market. The API has no cross-Market admin: it reads the slide out as a package
 * (the body of a create), and an editor of the other Market posts it there. This panel works in
 * one Market, so it cannot choose the other Market or create the copy itself; it hands over the
 * package as text or a file and says what is left out. Needs storefront.slide.edit here.
 */
export function SlideCopyDialog({
  open,
  slide,
  onClose,
}: {
  readonly open: boolean;
  readonly slide: { readonly id: string; readonly name: string };
  readonly onClose: () => void;
}) {
  const t = useTranslations('content.slides.dialog.copy');
  const td = useTranslations('content.slides.dialog');
  const router = useRouter();
  const [load, setLoad] = useState<Load>('loading');
  const [pack, setPack] = useState<SlideCopyPackage | null>(null);
  const [done, setDone] = useState<'copied' | 'copy-failed' | 'downloaded' | null>(null);
  const latest = useRef(0);

  const fetchPackage = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    setDone(null);
    const result = await callApi<SlideCopyPackage>('GET', copyPath(slide.id));
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      setPack(null);
      setLoad('failed');
      return;
    }
    setPack(result.body);
    setLoad('ready');
  }, [slide.id, router]);

  useEffect(() => {
    if (open) void fetchPackage();
    else latest.current++;
  }, [open, fetchPackage]);

  const text = pack === null ? '' : JSON.stringify(pack, null, 2);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setDone('copied');
    } catch {
      setDone('copy-failed');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `slide-${slide.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setDone('downloaded');
  }

  const placed = pack === null ? 0 : pack.placements.length;
  return (
    <Dialog
      open={open}
      title={t('title', { name: slide.name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {td('close')}
          </Button>
          <Button variant="secondary" disabled={load !== 'ready'} onClick={download}>
            {t('download')}
          </Button>
          <Button disabled={load !== 'ready'} onClick={() => void copyText()}>
            {t('copy')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p>{t('body')}</p>
        {load === 'loading' ? <p role="status">{t('loading')}</p> : null}
        {load === 'failed' ? (
          <Banner tone="critical">
            <p>{t('error')}</p>
            <button
              type="button"
              className="mt-1 font-medium underline"
              onClick={() => void fetchPackage()}
            >
              {t('retry')}
            </button>
          </Banner>
        ) : null}
        {load === 'ready' && pack !== null ? (
          <>
            <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
              <li>{t('kept', { count: placed })}</li>
              <li>{t('cleared')}</li>
              <li>{t('draft')}</li>
            </ul>
            <p role="status" aria-live="polite" className="text-sm">
              {done === null ? null : t(`done.${done}`)}
            </p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
