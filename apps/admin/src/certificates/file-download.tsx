'use client';

import { Button, saveFile } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

type Failure = 'disabled' | 'denied' | 'missing' | 'unavailable';

/** What the user is told for each refusal of the API (one message per cause). */
function failureOf(status: number, code: string | undefined): Failure {
  if (status === 403 && code === 'document.download-disabled') return 'disabled';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'missing';
  return 'unavailable';
}

/** The name the server made, without any path part; a fixed one when it sent none. */
function nameOf(disposition: string | null, fallback: string): string {
  const named = /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? '';
  const cleaned = named.replace(/[/\\]/g, '').trim();
  return cleaned === '' ? fallback : cleaned;
}

/**
 * The download control of one file of a submission or an issuer request (certification). It reads
 * the file through the panel's relay and hands it to the browser; the API decides who may read
 * (the review permission) and whether the Market's switch is on, so a refusal is worded here, not
 * guessed beforehand. `path` is the API path of the file; `n` is its place in the list.
 */
export function FileDownload({ path, n }: { readonly path: string; readonly n: number }) {
  const t = useTranslations('certificates.file-download');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const download = async () => {
    setBusy(true);
    setFailure(null);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/${path}`, { credentials: 'same-origin', cache: 'no-store' });
      } catch {
        setFailure('unavailable');
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
        } | null;
        setFailure(failureOf(response.status, body?.code));
        return;
      }
      // Anything but the attachment the API sends (an HTML error page from a proxy) is not saved.
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/octet-stream') {
        setFailure('unavailable');
        return;
      }
      const name = nameOf(response.headers.get('content-disposition'), `file-${n}`);
      saveFile(
        new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' }),
        name,
      );
    } catch {
      // The connection broke while the file was streaming: nothing was saved.
      setFailure('unavailable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button variant="secondary" loading={busy} disabled={busy} onClick={() => void download()}>
        {t('button', { n })}
      </Button>
      <span role="status" className="text-sm text-fg-muted">
        {failure === null ? null : t(`failure.${failure}`)}
      </span>
    </span>
  );
}
