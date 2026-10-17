import { BackLink, LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { OrderDetail } from '../../../../src/orders/order-detail.tsx';
import { VIEW_PERMISSION, type AdminOrder } from '../../../../src/orders/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.detail.page-title') };
}

export default async function OrderPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;
  if (!UUID.test(orderId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('orders.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="orders" title={title}>
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'not-found') =>
    shell(
      <div className="flex flex-col gap-4">
        <BackLink href="/orders" label={t('orders.detail.back')} />
        <div>
          <h1 className="mb-2 text-2xl font-semibold">{t(`orders.${key}-title`)}</h1>
          <p className="text-fg-muted">{t(`orders.${key}`)}</p>
        </div>
      </div>,
    );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) return message('no-access');
  const result = await serverGet<AdminOrder>(`ordering/admin/orders/${orderId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'ok') return shell(<OrderDetail order={result.body} />);
  if (result.kind === 'forbidden') return message('no-access');
  if (result.kind === 'not-found') return message('not-found');
  return shell(<LoadError message={t('orders.error.unavailable')} retryLabel={t('load.retry')} />);
}
