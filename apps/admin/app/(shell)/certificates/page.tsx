import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { CertificateQueue } from '../../../src/certificates/queue.tsx';
import { typeNames } from '../../../src/certificates/format.ts';
import {
  PAGE_SIZE,
  TYPE_VIEW_PERMISSION,
  VIEW_PERMISSION,
  type QueuePage,
  type TypesList,
} from '../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.title') };
}

/**
 * Certificates (certificate screens design, A1): the seller certificates waiting for a decision,
 * oldest first, in keyset pages. Type names come from the types list when the reader may view
 * types; otherwise the table shows the type code.
 */
export default async function CertificatesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly after?: string | readonly string[] }>;
}) {
  const { after } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'unavailable') => (
    <>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.queue.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t('certificates.queue.no-access')}</p>
      )}
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('certificates.queue.back-home')}
        </a>
      </p>
    </>
  );
  const keys = gate.session.permissionKeys;
  if (!keys.includes(VIEW_PERMISSION)) return shell(message('no-access'));

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (typeof after === 'string' && after !== '') query.set('afterId', after);
  const [result, types] = await Promise.all([
    serverGet<QueuePage>(`certification/admin/seller-certificates?${query.toString()}`),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<TypesList>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const locale = await getLocale();
  // A types list that could not be read only costs the names; the queue still shows the codes.
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  const next = result.body.nextAfterId;
  return shell(
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">
        {t('certificates.queue.total', { count: result.body.total })}
      </p>
      <CertificateQueue rows={result.body.items} typeNames={names} morePages={next !== null} />
      {next === null ? null : (
        <p>
          <a
            className="font-medium text-link underline"
            href={`/certificates?after=${encodeURIComponent(next)}`}
          >
            {t('certificates.queue.more')}
          </a>
        </p>
      )}
    </div>,
  );
}
