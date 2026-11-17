import { BackLink, LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  OrderDocumentView,
  type OrderDocument,
} from '../../../../../src/orders/order-document.tsx';
import { VIEW_PERMISSION, type AdminOrder } from '../../../../../src/orders/types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('orders.document.title') };
}

/** The printable order confirmation of a paid order (order detail, Documents). */
export default async function OrderDocumentPage({
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
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="orders" title={t('orders.title')}>
      {body}
    </AdminShell>
  );
  const message = (text: string) =>
    shell(
      <div className="flex flex-col gap-4">
        <BackLink href={`/orders/${orderId}`} label={t('orders.document.back')} />
        <p className="text-fg-muted">{text}</p>
      </div>,
    );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) return message(t('orders.no-access'));
  const [document, order] = await Promise.all([
    serverGet<OrderDocument>(`ordering/admin/orders/${orderId}/document`),
    serverGet<AdminOrder>(`ordering/admin/orders/${orderId}`),
  ]);
  if (document.kind === 'signed-out' || order.kind === 'signed-out') redirect('/session-ended');
  if (document.kind === 'ok') {
    return shell(
      <OrderDocumentView
        document={document.body}
        parts={order.kind === 'ok' ? order.body.sellerOrders : []}
      />,
    );
  }
  if (document.kind === 'forbidden') return message(t('orders.no-access'));
  if (document.kind === 'not-found') return message(t('orders.not-found'));
  if (document.kind === 'conflict') return message(t('orders.document.not-paid'));
  return shell(<LoadError message={t('orders.error.unavailable')} retryLabel={t('load.retry')} />);
}
