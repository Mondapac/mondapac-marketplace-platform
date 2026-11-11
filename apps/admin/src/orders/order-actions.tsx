'use client';

import { Banner, Button, CheckboxRow, Dialog, Menu, Select, TextField } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi, type ApiFailure, type ApiResult } from '../api/client.ts';
import { parseAmount } from '../wallet/money.ts';
import { cancelBlock, refundBlock, refundsOf, shippingGiven, unitsLeft } from './refunds.ts';
import {
  LOSS_BEARERS,
  LOSS_REASON_CODES,
  REFUND_REASONS,
  type AdminOrderDetail,
  type CancelAnswer,
  type SellerPart,
} from './types.ts';

// The money actions of the order page (order detail decisions 1 and 6 of the design): cancel and
// refund the whole order from the More menu while no seller has started, and refund one seller
// order by hand. Both need ordering.order.refund and the Market's refund switch. Each asks for a
// reason and who bears the loss, and a second confirmation before anything is sent. The page is
// read again afterwards, so the refunds and their states come from the server.

/** The API codes the dialogs explain; anything else is the generic error. */
const KNOWN_PROBLEMS = [
  'ordering.cancel-too-late',
  'ordering.cancel-nothing-left',
  'ordering.refund-in-progress',
  'ordering.refund-disabled',
  'ordering.refund-not-allowed',
  'ordering.refund-tax-unknown',
  'ordering.refund-tax-unavailable',
  'ordering.refund-exceeds',
  'ordering.refund-rejected',
  'ordering.seller-order-not-found',
  'ordering.order-not-found',
  'conflict.retry',
  'access.denied',
  'validation.failed',
  'network',
] as const;
type Problem = (typeof KNOWN_PROBLEMS)[number] | 'unknown';

function problemOf(failure: ApiFailure): Problem {
  const code = failure.code;
  return (KNOWN_PROBLEMS as readonly string[]).includes(code) ? (code as Problem) : 'unknown';
}

const problemKey = (problem: Problem): string => `actions.problem.${problem.replace(/\./g, '-')}`;

interface Loss {
  readonly reason: string;
  readonly lossBearer: string;
  readonly lossReasonCode: string;
}

const NO_LOSS: Loss = { reason: '', lossBearer: 'seller', lossReasonCode: '' };

/** The body fields shared by cancel and refund. */
const lossBody = (loss: Loss) => ({
  reason: loss.reason,
  lossBearer: loss.lossBearer,
  ...(loss.lossBearer === 'platform' ? { lossReasonCode: loss.lossReasonCode } : {}),
});

const lossReady = (loss: Loss): boolean =>
  loss.reason !== '' && (loss.lossBearer !== 'platform' || loss.lossReasonCode !== '');

/** Reason, who bears the loss and, when the platform does, why. */
function LossFields({
  loss,
  disabled,
  onChange,
}: {
  readonly loss: Loss;
  readonly disabled: boolean;
  readonly onChange: (next: Loss) => void;
}) {
  const t = useTranslations('orders.actions');
  return (
    <>
      <Select
        label={t('reason')}
        placeholder={t('reason-placeholder')}
        value={loss.reason}
        disabled={disabled}
        required
        options={REFUND_REASONS.map((value) => ({ value, label: t(`refund-reason.${value}`) }))}
        onChange={(event) => onChange({ ...loss, reason: event.target.value })}
      />
      <Select
        label={t('loss-bearer')}
        help={t('loss-bearer-help')}
        value={loss.lossBearer}
        disabled={disabled}
        options={LOSS_BEARERS.map((value) => ({ value, label: t(`loss-bearer-option.${value}`) }))}
        onChange={(event) =>
          onChange({ ...loss, lossBearer: event.target.value, lossReasonCode: '' })
        }
      />
      {loss.lossBearer === 'platform' ? (
        <Select
          label={t('loss-reason')}
          placeholder={t('reason-placeholder')}
          value={loss.lossReasonCode}
          disabled={disabled}
          required
          options={LOSS_REASON_CODES.map((value) => ({
            value,
            label: t(`loss-reason-option.${value}`),
          }))}
          onChange={(event) => onChange({ ...loss, lossReasonCode: event.target.value })}
        />
      ) : null}
    </>
  );
}

/** One POST at a time; a 401 leaves the page for the session-ended screen. */
function useSend() {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  async function send<T>(request: () => Promise<ApiResult<T>>): Promise<T | null> {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await request();
    busy.current = false;
    setPending(false);
    if (result.ok) return result.body;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return null;
    }
    setProblem(problemOf(result.failure));
    return null;
  }
  return { pending, problem, send };
}

function ProblemBanner({ problem }: { readonly problem: Problem | null }) {
  const t = useTranslations('orders');
  if (problem === null) return null;
  return (
    <Banner tone={problem === 'ordering.refund-in-progress' ? 'attention' : 'critical'}>
      {t(problemKey(problem))}
    </Banner>
  );
}

/** The More menu of the order header, with Cancel and refund (decision 1). */
export function OrderMoreMenu({
  order,
  canRefund,
  csrfToken,
}: {
  readonly order: AdminOrderDetail;
  readonly canRefund: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('orders.actions');
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<CancelAnswer | null>(null);
  if (!canRefund) return null;
  const block = cancelBlock(order);
  return (
    <>
      <div className="ms-auto">
        <Menu
          label={t('more')}
          items={[
            {
              id: 'cancel',
              label: t('cancel.open'),
              tone: 'critical',
              disabled: block !== null,
              ...(block === null ? {} : { reason: t(`cancel.block.${block}`) }),
              onSelect: () => setOpen(true),
            },
          ]}
        />
      </div>
      {done === null ? null : <CancelResult answer={done} />}
      {open ? (
        <CancelDialog
          order={order}
          csrfToken={csrfToken}
          onClose={() => setOpen(false)}
          onDone={(answer) => {
            setOpen(false);
            setDone(answer);
          }}
        />
      ) : null}
    </>
  );
}

function CancelResult({ answer }: { readonly answer: CancelAnswer }) {
  const t = useTranslations('orders.actions.cancel');
  const failed = answer.refunds.filter((refund) => refund.state === 'failed').length;
  const pending = answer.refunds.filter((refund) => refund.state === 'pending').length;
  return (
    <div className="basis-full" role="status">
      <Banner tone={failed > 0 ? 'critical' : pending > 0 ? 'attention' : 'success'}>
        {failed > 0
          ? t('done-failed', { count: failed })
          : pending > 0
            ? t('done-pending', { count: pending })
            : t('done')}
      </Banner>
    </div>
  );
}

function CancelDialog({
  order,
  csrfToken,
  onClose,
  onDone,
}: {
  readonly order: AdminOrderDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (answer: CancelAnswer) => void;
}) {
  const t = useTranslations('orders.actions');
  const router = useRouter();
  const [loss, setLoss] = useState<Loss>(NO_LOSS);
  const [sure, setSure] = useState(false);
  const { pending, problem, send } = useSend();
  const keep = useRef<HTMLButtonElement>(null);
  const ready = lossReady(loss) && sure;

  async function confirm() {
    const answer = await send(() =>
      callApi<CancelAnswer>(
        'POST',
        `ordering/admin/orders/${order.orderId}/cancel`,
        lossBody(loss),
        csrfToken,
      ),
    );
    if (answer === null) return;
    onDone(answer);
    router.refresh();
  }

  return (
    <Dialog
      open
      size="form"
      title={t('cancel.title')}
      onClose={() => (pending ? undefined : onClose())}
      initialFocus={keep}
      actions={
        <>
          <Button ref={keep} variant="secondary" disabled={pending} onClick={onClose}>
            {t('keep')}
          </Button>
          <Button
            variant="destructive-solid"
            disabled={!ready}
            loading={pending}
            onClick={() => void confirm()}
          >
            {t('cancel.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{t('cancel.body', { sellers: order.sellerOrders.length })}</p>
        <ProblemBanner problem={problem} />
        <LossFields loss={loss} disabled={pending} onChange={setLoss} />
        <CheckboxRow
          label={t('cancel.sure')}
          checked={sure}
          disabled={pending}
          onChange={(event) => setSure(event.target.checked)}
        />
      </div>
    </Dialog>
  );
}

/** Refund… on a seller order's card: some or all of what is left of it. */
export function RefundButton({
  order,
  part,
  canRefund,
  csrfToken,
}: {
  readonly order: AdminOrderDetail;
  readonly part: SellerPart;
  readonly canRefund: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('orders.actions');
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  if (!canRefund) return null;
  const block = refundBlock(order, part);
  const noteId = `refund-note-${part.sellerOrderId}`;
  return (
    <div className="flex flex-col items-start gap-2">
      {done ? (
        <Banner tone="success">
          <span role="status">{t('refund.done')}</span>
        </Banner>
      ) : null}
      <Button
        variant="secondary"
        disabled={block !== null}
        aria-describedby={block === null ? undefined : noteId}
        onClick={() => {
          setDone(false);
          setOpen(true);
        }}
      >
        {t('refund.open')}
      </Button>
      {block === null ? null : (
        <p id={noteId} className="text-sm text-fg-muted">
          {t(`refund.block.${block}`)}
        </p>
      )}
      {open ? (
        <RefundDialog
          order={order}
          part={part}
          csrfToken={csrfToken}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            setDone(true);
          }}
        />
      ) : null}
    </div>
  );
}

function RefundDialog({
  order,
  part,
  csrfToken,
  onClose,
  onDone,
}: {
  readonly order: AdminOrderDetail;
  readonly part: SellerPart;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('orders.actions');
  const router = useRouter();
  const refunds = refundsOf(order, part);
  const left = unitsLeft(part, refunds);
  const [units, setUnits] = useState<Readonly<Record<string, string>>>({});
  const [shipping, setShipping] = useState('');
  const [loss, setLoss] = useState<Loss>(NO_LOSS);
  const [sure, setSure] = useState(false);
  const { pending, problem, send } = useSend();
  const keep = useRef<HTMLButtonElement>(null);
  const currency = part.shipping.currency;

  const lineErrors = new Map<string, string>();
  const lines: { orderLineId: string; quantity: number }[] = [];
  for (const line of part.lines) {
    const text = (units[line.lineId] ?? '').trim();
    if (text === '' || text === '0') continue;
    const quantity = /^[0-9]{1,6}$/.test(text) ? Number(text) : Number.NaN;
    const max = left.get(line.lineId) ?? 0;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
      lineErrors.set(line.lineId, t('refund.units-error', { max }));
    } else lines.push({ orderLineId: line.lineId, quantity });
  }
  const shippingParse = shipping.trim() === '' ? null : parseAmount(shipping, currency);
  const shippingError =
    shippingParse === null || shippingParse.ok ? undefined : t('refund.shipping-error');
  const anything = lines.length > 0 || shippingParse?.ok === true;
  const ready =
    anything && lineErrors.size === 0 && shippingError === undefined && lossReady(loss) && sure;
  const given = shippingGiven(refunds);

  async function confirm() {
    const body = {
      lines,
      ...(shippingParse?.ok === true ? { shippingAmount: shippingParse.minor } : {}),
      ...lossBody(loss),
    };
    const answer = await send(() =>
      callApi<unknown>(
        'POST',
        `ordering/admin/orders/${order.orderId}/seller-orders/${part.sellerOrderId}/refunds`,
        body,
        csrfToken,
      ),
    );
    if (answer === null) return;
    onDone();
    router.refresh();
  }

  return (
    <Dialog
      open
      size="form"
      title={t('refund.title', { seller: part.storeName?.trim() || t('refund.this-seller') })}
      onClose={() => (pending ? undefined : onClose())}
      initialFocus={keep}
      actions={
        <>
          <Button ref={keep} variant="secondary" disabled={pending} onClick={onClose}>
            {t('keep')}
          </Button>
          <Button
            variant="destructive-solid"
            disabled={!ready}
            loading={pending}
            onClick={() => void confirm()}
          >
            {t('refund.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{t('refund.body')}</p>
        <ProblemBanner problem={problem} />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">{t('refund.items')}</legend>
          {part.lines.map((line) => {
            const max = left.get(line.lineId) ?? 0;
            return (
              <TextField
                key={line.lineId}
                label={t('refund.units-label', {
                  item: line.productName?.trim() || t('refund.item'),
                  max,
                })}
                inputMode="numeric"
                value={units[line.lineId] ?? ''}
                disabled={pending || max === 0}
                error={lineErrors.get(line.lineId)}
                onChange={(event) =>
                  setUnits((current) => ({ ...current, [line.lineId]: event.target.value }))
                }
              />
            );
          })}
        </fieldset>
        {part.shipping.amount === '0' ? null : (
          <TextField
            label={t('refund.shipping', { currency })}
            help={given > 0n ? t('refund.shipping-given') : t('refund.shipping-help')}
            inputMode="decimal"
            value={shipping}
            disabled={pending}
            error={shippingError}
            onChange={(event) => setShipping(event.target.value)}
          />
        )}
        <LossFields loss={loss} disabled={pending} onChange={setLoss} />
        <CheckboxRow
          label={t('refund.sure')}
          checked={sure}
          disabled={pending}
          onChange={(event) => setSure(event.target.checked)}
        />
      </div>
    </Dialog>
  );
}
