import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { OfferReviewPanel } from '../../../../src/offer-review-settings/offer-review-panel.tsx';
import {
  OFFER_REVIEW_MANAGE_PERMISSION,
  OFFER_REVIEW_PATH,
  OFFER_REVIEW_VIEW_PERMISSION,
  offerReviewAnswerOf,
} from '../../../../src/offer-review-settings/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('offer-review-settings.title') };
}

/** Settings › Catalogue › Offer review: the Market's Offer review policy. */
export default async function OfferReviewSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('offer-review-settings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="offer-review" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(OFFER_REVIEW_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('offer-review-settings.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<unknown>(OFFER_REVIEW_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  const answer = read.kind === 'ok' ? offerReviewAnswerOf(read.body) : null;
  if (answer === null) {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('offer-review-settings.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <OfferReviewPanel
      initial={answer}
      canManage={permissionKeys.includes(OFFER_REVIEW_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
