import { EmptyState, LoadError, PageHeader } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';
import { ChangePage } from '../../../../src/offer-review/change-page.tsx';
import {
  API_CHANGES,
  DECIDE_PERMISSION,
  VIEW_PERMISSION,
  changeName,
  type ChangeRow,
} from '../../../../src/offer-review/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('offer-review.change.title') };
}

/** One held edit of a live Offer: the deep link of the decision drawer's content. */
export default async function OfferChangePage({
  params,
}: {
  readonly params: Promise<{ readonly changeId: string }>;
}) {
  const { changeId } = await params;
  if (!UUID.test(changeId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, csrfToken } = gate.session;
  const title = t('offer-review.change.title');
  const shell = (body: React.ReactNode, heading = title) => (
    <AdminShell session={gate.session} activeId="offer-reviews" title={heading}>
      {body}
    </AdminShell>
  );
  const empty = (key: 'no-access' | 'not-found') =>
    shell(
      <EmptyState
        size="page"
        icon={key === 'no-access' ? 'lock' : 'search'}
        title={t(`offer-review.change.${key}.title`)}
        body={t(`offer-review.change.${key}.body`, { permission: VIEW_PERMISSION })}
        action={
          <a className="font-medium text-link underline" href="/offer-reviews?tab=edits">
            {t('offer-review.queue.back')}
          </a>
        }
      />,
    );
  if (!permissionKeys.includes(VIEW_PERMISSION)) return empty('no-access');
  const read = await serverGet<ChangeRow>(`${API_CHANGES}/${changeId}`);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind === 'forbidden') return empty('no-access');
  if (read.kind === 'not-found') return empty('not-found');
  if (read.kind !== 'ok') {
    return shell(
      <>
        <PageHeader title={title} className="mb-4" />
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('offer-review.change.unavailable')}
          retryLabel={t('load.retry')}
        />
      </>,
    );
  }
  return shell(
    <>
      <PageHeader title={changeName(read.body)} className="mb-4" />
      <ChangePage
        change={read.body}
        csrfToken={csrfToken}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        canDecide={permissionKeys.includes(DECIDE_PERMISSION)}
        permissionKeys={permissionKeys}
      />
    </>,
    changeName(read.body),
  );
}
