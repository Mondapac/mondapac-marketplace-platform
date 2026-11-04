import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { ModerationQueue } from '../../../../src/reviews/moderation-queue.tsx';
import {
  MODERATE_PERMISSION,
  REMOVE_PERMISSION,
  VIEW_PERMISSION,
} from '../../../../src/reviews/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('reviews-moderation.title') };
}

export default async function ReviewModerationPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  const title = t('reviews-moderation.title');
  if (gate.kind === 'unavailable') {
    // No session, so no shell; the page still has its heading.
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </div>
    );
  }
  const keys = gate.session.permissionKeys;
  return (
    <AdminShell session={gate.session} activeId="review-moderation" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {keys.includes(VIEW_PERMISSION) ? (
        <ModerationQueue
          canModerate={keys.includes(MODERATE_PERMISSION)}
          canRemove={keys.includes(REMOVE_PERMISSION)}
          csrfToken={gate.session.csrfToken}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('reviews-moderation.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('reviews-moderation.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
