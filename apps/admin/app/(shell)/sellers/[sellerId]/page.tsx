import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import {
  CHECK_PERMISSION,
  DECIDE_PERMISSION,
  REVIEW_PERMISSION,
  type ReviewRead,
} from '../../../../src/sellers/review-types.ts';
import { ReviewView } from '../../../../src/sellers/review-view.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.review.title') };
}

export default async function SellerReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly sellerId: string }>;
}) {
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  const title = t('sellers.review.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      {body}
    </AdminShell>
  );
  const message = (key: string) =>
    shell(
      <>
        <h1 className="mb-2 text-2xl font-semibold">{t(`sellers.review.${key}.title`)}</h1>
        <p className="text-fg-muted">{t(`sellers.review.${key}.body`)}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/sellers">
            {t('sellers.review.back')}
          </a>
        </p>
      </>,
    );
  // The API audits every read of business details, so a page without the permission makes no call.
  if (!gate.session.permissionKeys.includes(REVIEW_PERMISSION)) return message('no-access');
  const result = await serverGet<ReviewRead>(`sellers/admin/${sellerId}/review`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'ok') {
    const { permissionKeys, csrfToken } = gate.session;
    const decide = {
      canDecide: permissionKeys.includes(DECIDE_PERMISSION),
      canCheck: permissionKeys.includes(CHECK_PERMISSION),
      csrfToken,
    };
    return shell(<ReviewView review={result.body} decide={decide} />);
  }
  if (result.kind === 'forbidden') return message('no-access');
  if (result.kind === 'not-found') return message('not-found');
  if (result.kind === 'conflict') return message('no-revision');
  return message('unavailable');
}
