import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { typeNames } from '../../../../src/certificates/format.ts';
import { ReviewView } from '../../../../src/certificates/review/review-view.tsx';
import {
  API_CERTIFICATES,
  APPROVE_PERMISSION,
  REVIEW_PERMISSION,
  type ReviewPage,
} from '../../../../src/certificates/review/types.ts';
import { TYPE_VIEW_PERMISSION, type TypesList } from '../../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.review.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Review a certificate (certificates design CA2). The page decrypts the submission, so it needs the
 * review permission; the read is audited by the API. `reason=duplicate-hint` marks a visit from a
 * hint and is the only value passed on.
 */
export default async function ReviewPageRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly certificateId: string }>;
  readonly searchParams: Promise<{ readonly reason?: string | readonly string[] }>;
}) {
  const { certificateId } = await params;
  const { reason } = await searchParams;
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
  const message = (key: 'no-access' | 'unavailable' | 'not-found') => (
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href="/certificates">
          {t('certificates.review.back')}
        </a>
      </p>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.review.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`certificates.review.${key}`)}</p>
      )}
    </>
  );
  const keys = gate.session.permissionKeys;
  if (!keys.includes(REVIEW_PERMISSION)) return shell(message('no-access'));
  if (!UUID.test(certificateId)) return shell(message('not-found'));

  const query = reason === 'duplicate-hint' ? '?reason=duplicate-hint' : '';
  const [result, types] = await Promise.all([
    serverGet<ReviewPage>(`${API_CERTIFICATES}/${certificateId}${query}`),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<TypesList>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind === 'not-found') return shell(message('not-found'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const locale = await getLocale();
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  return shell(
    <ReviewView
      page={result.body}
      typeName={names.get(result.body.certificate.typeCode) ?? result.body.certificate.typeCode}
      canReview
      canDecide={keys.includes(APPROVE_PERMISSION)}
      csrfToken={gate.session.csrfToken}
    />,
  );
}
