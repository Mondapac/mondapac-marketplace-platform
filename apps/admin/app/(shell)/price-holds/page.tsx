import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { HoldsQueue } from '../../../src/pricing/holds-queue.tsx';
import {
  DECIDE_PERMISSION,
  PAGE_SIZE,
  VIEW_PERMISSION,
  type PriceHoldPage,
} from '../../../src/pricing/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('pricing.holds.title') };
}

export default async function PriceHoldsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly after?: string | readonly string[] }>;
}) {
  const { after } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  const title = t('pricing.holds.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="price-holds" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  const message = (key: string) => (
    <>
      <p className="text-fg-muted">{t(`pricing.holds.${key}`)}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('pricing.holds.back-home')}
        </a>
      </p>
    </>
  );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return shell(message('no-access'));
  }
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (typeof after === 'string' && after !== '') query.set('after', after);
  const result = await serverGet<PriceHoldPage>(`pricing/admin/price-holds?${query.toString()}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  return shell(
    <div className="flex flex-col gap-4">
      <HoldsQueue
        rows={result.body.items}
        canDecide={gate.session.permissionKeys.includes(DECIDE_PERMISSION)}
        csrfToken={gate.session.csrfToken}
      />
      {result.body.next === null ? null : (
        <p>
          <a
            className="font-medium text-link underline"
            href={`/price-holds?after=${encodeURIComponent(result.body.next)}`}
          >
            {t('pricing.holds.more')}
          </a>
        </p>
      )}
    </div>,
  );
}
