'use client';

import {
  Banner,
  Button,
  DataList,
  Dialog,
  Icon,
  LinkButton,
  SettingsPage,
  SettingsSection,
  SettingsViewOnlyBanner,
  toast,
  type BannerTone,
} from '@mondapac/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { zonePlace } from './certificate-form.tsx';
import { orderedDocuments } from './documents-card.tsx';
import { certificateProblemOf } from './errors.ts';
import { formatDay } from './format.ts';
import {
  formPathOf,
  nextStepKey,
  statusActions,
  statusLook,
  type CertificateAction,
} from './status.ts';
import { CertificateStatusBadge } from './status-badge.tsx';
import { SellerAccountLine } from './seller-account-line.tsx';
import { mediaLabel } from './upload.ts';
import {
  CERTIFICATES_PATH,
  typeName,
  type CertificateDecision,
  type CertificateDetail,
  type CertificateDraft,
  type CertificateHistoryEntry,
  type CertificateInForce,
  type CertificateSummary,
  type CertificateTypeOption,
  type SellerAccountState,
} from './types.ts';

/** The list with the start dialog open: "Add a certificate" after a decline or a revoke. */
export const ADD_CERTIFICATE_PATH = `${CERTIFICATES_PATH}?add=1`;

/** Statuses whose card shows the certificate in force beside the renewal (design 11, "View both"). */
const RENEWAL_STATUSES: ReadonlySet<string> = new Set([
  'approved-renewal-pending',
  'approved-renewal-changes-needed',
  'expired-renewal-pending',
]);

/** Statuses with an approval: the details shown are the approved submission's. */
const APPROVED_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'approved-expiring',
  'expired',
  'issuer-not-recognised',
]);

/** The history events the panel has words for (`certification.history.<event>`). */
const HISTORY_EVENTS: ReadonlySet<string> = new Set([
  'submitted',
  'submitted-again',
  'renewal-submitted',
  'approved',
  'changes-requested',
  'declined',
  'withdrawn',
  'expired',
  'revoked',
]);

const CARD_TONE: Readonly<Record<string, BannerTone>> = {
  neutral: 'info',
  info: 'info',
  attention: 'attention',
  critical: 'critical',
  success: 'success',
};

type Translate = ReturnType<typeof useTranslations>;

interface StatusCopy {
  readonly title: string;
  readonly body: readonly string[];
}

/**
 * The status card's words (ux.md 3.2 and section 5): a title and its body for each status. Dates
 * come from the API (`validUntil`, `renewalSubmitBy`), never counted here.
 */
export function statusCopy(
  t: Translate,
  certificate: CertificateSummary,
  values: {
    readonly type: string;
    readonly validUntil: string | null;
    readonly submitBy: string | null;
    readonly zoneName: string | null;
    readonly issuer: string | null;
  },
): StatusCopy {
  const date = values.validUntil ?? t('certification.list.none');
  const validLine =
    values.validUntil === null
      ? null
      : values.zoneName === null
        ? t('certification.review.expiry-plain', { date })
        : t('certification.status.valid-until', { date, zoneName: values.zoneName });
  switch (certificate.status) {
    case 'awaiting-review':
      return { title: t('certification.awaiting.title'), body: [t('certification.awaiting.body')] };
    case 'changes-needed':
      return { title: t('certification.changes.title'), body: [t('certification.changes.body')] };
    case 'declined':
      return { title: t('certification.declined.title'), body: [t('certification.declined.body')] };
    case 'approved':
      return {
        title: t('certification.approved.title'),
        body: [t('certification.approved.body', { type: values.type }), validLine].filter(
          (line): line is string => line !== null,
        ),
      };
    case 'approved-expiring':
      return {
        title: t('certification.expiring.title', { date }),
        body: [
          values.submitBy === null
            ? t('certification.expiring.body-plain', {
                date,
                zoneName: values.zoneName ?? t('certification.status.your-time'),
              })
            : t('certification.expiring.body', {
                date,
                zoneName: values.zoneName ?? t('certification.status.your-time'),
                submitBy: values.submitBy,
              }),
        ],
      };
    case 'approved-renewal-pending':
      return {
        title: t('certification.renewal-pending.title'),
        body: [t('certification.renewal-pending.body', { date })],
      };
    case 'approved-renewal-changes-needed':
      return {
        title: t('certification.renewal-changes.title'),
        body: [t('certification.renewal-changes.body', { date })],
      };
    case 'expired':
      return { title: t('certification.expired.title'), body: [t('certification.expired.body')] };
    case 'expired-renewal-pending':
      return {
        title: t('certification.renewal-pending.title'),
        body: [t('certification.expired-renewal.body')],
      };
    case 'revoked':
      return { title: t('certification.revoked.title'), body: [t('certification.revoked.body')] };
    case 'issuer-not-recognised':
      return {
        title:
          values.issuer === null
            ? t('certification.issuer-not-recognised.title-plain')
            : t('certification.issuer-not-recognised.title', { issuer: values.issuer }),
        body: [t('certification.issuer-not-recognised.body')],
      };
    default:
      return { title: t(statusLook(certificate.status).labelKey), body: [] };
  }
}

/**
 * The status page (design section 9, CS5): one page for every status but a draft, whose own page
 * is its form. The header holds the type name, the status badge and that status's buttons, from
 * the API's flags. Under it: the seller account's own state (CERT-12), the status card with the
 * reason of a decision, the submitted details (read only), the certificate in force beside a
 * renewal, and a short history. Nothing here is a review time, a queue position or a reviewer.
 */
export function CertificateStatusPage({
  detail,
  type,
  canManage,
  account,
  zone,
  csrfToken,
}: {
  readonly detail: CertificateDetail;
  readonly type: CertificateTypeOption | undefined;
  readonly canManage: boolean;
  readonly account: SellerAccountState;
  readonly zone: string | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const cancelWithdraw = useRef<HTMLButtonElement>(null);
  const viewOnlyId = useId();
  const closedTypeId = useId();
  const { certificate } = detail;
  const name = typeName(type?.names, certificate.typeCode, locale);
  const title = t('certification.form.page-title', { type: name });
  const day = (value: string | null | undefined) =>
    formatDay((date, options) => format.dateTime(date, options), value);
  const zoneName =
    zone === null ? null : t('certification.form.zone-time', { place: zonePlace(zone) });
  const instant = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const text = format.dateTime(date, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: zone ?? 'UTC',
    });
    return zoneName === null ? text : `${text} ${zoneName}`;
  };

  const inForce = detail.inForce ?? null;
  const copy = statusCopy(t, certificate, {
    type: name,
    validUntil: day(certificate.validUntil ?? inForce?.expiryDate ?? null),
    submitBy: day(certificate.renewalSubmitBy),
    zoneName,
    issuer: inForce?.issuerName ?? certificate.issuerName ?? null,
  });
  const look = statusLook(certificate.status);
  const decision = detail.decision ?? null;

  async function withdraw() {
    if (busy.current) return;
    busy.current = true;
    setWithdrawing(true);
    setProblem(null);
    const result = await callApi<CertificateSummary>(
      'POST',
      `certification/seller/certificates/${certificate.certificateId}/withdraw`,
      undefined,
      csrfToken,
    );
    busy.current = false;
    setWithdrawing(false);
    setConfirmWithdraw(false);
    if (result.ok) {
      toast.success(t('certification.withdraw.done'));
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const found = certificateProblemOf(result.failure);
    setProblem(found.key);
    if (found.then === 'reload') router.refresh();
    if (found.then === 'list') router.push(CERTIFICATES_PATH);
  }

  const actions = statusActions(certificate);
  const header =
    actions.length === 0 ? undefined : (
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <ActionButton
            key={action.id}
            action={action}
            href={action.kind === 'add' ? ADD_CERTIFICATE_PATH : formPathOf(certificate)}
            blocked={!canManage || (action.kind === 'form' && type === undefined)}
            reasonId={!canManage ? viewOnlyId : type === undefined ? closedTypeId : undefined}
            onWithdraw={() => setConfirmWithdraw(true)}
            label={t(action.labelKey)}
          />
        ))}
      </div>
    );

  const banners = [
    canManage ? null : (
      <div key="view-only" id={viewOnlyId}>
        <SettingsViewOnlyBanner title={t('settings.view-only.title')}>
          {t('certification.view-only.ask-owner')}
        </SettingsViewOnlyBanner>
      </div>
    ),
    // The type is no longer open: its form settings are not sent, so the form can't open (FE item).
    canManage && type === undefined && actions.some((action) => action.kind === 'form') ? (
      <div key="closed-type" id={closedTypeId}>
        <Banner tone="info">{t('certification.error.type.inactive', { type: name })}</Banner>
      </div>
    ) : null,
    problem === null ? null : (
      <div key="problem" aria-live="polite">
        <Banner tone="critical">{t(problem, { type: name })}</Banner>
      </div>
    ),
  ].filter((node) => node !== null);

  const showsInForce = inForce !== null && RENEWAL_STATUSES.has(certificate.status);
  const approvedValues = APPROVED_STATUSES.has(certificate.status) && inForce !== null;
  const history = (detail.history ?? []).filter((entry) => HISTORY_EVENTS.has(entry.event));
  const lastSubmitted = history.find((entry) => entry.event.endsWith('submitted'));
  const timeLine =
    decision !== null
      ? t('certification.status.decided-on', { dateTime: instant(decision.decidedAt) })
      : lastSubmitted !== undefined && !APPROVED_STATUSES.has(certificate.status)
        ? t('certification.status.submitted-on', { dateTime: instant(lastSubmitted.at) })
        : null;

  return (
    <SettingsPage
      title={title}
      statusBadge={<CertificateStatusBadge status={certificate.status} />}
      actions={header}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      overlay={
        <Dialog
          open={confirmWithdraw}
          title={t('certification.withdraw.title')}
          onClose={() => (withdrawing ? undefined : setConfirmWithdraw(false))}
          initialFocus={cancelWithdraw}
          actions={
            <>
              <Button
                ref={cancelWithdraw}
                variant="secondary"
                onClick={() => setConfirmWithdraw(false)}
                disabled={withdrawing}
              >
                {t('certification.action.cancel')}
              </Button>
              <Button
                variant="destructive-solid"
                onClick={() => void withdraw()}
                loading={withdrawing}
              >
                {t('certification.withdraw.action')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-secondary">{t('certification.withdraw.body')}</p>
        </Dialog>
      }
    >
      <SellerAccountLine account={account} />
      <Banner tone={CARD_TONE[look.tone] ?? 'info'} title={copy.title}>
        {copy.body.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {decision === null ? null : <DecisionReason decision={decision} t={t} />}
      </Banner>
      {account !== 'approved' && certificate.status === 'awaiting-review' ? (
        <Banner tone="info">{t('certification.awaiting.seller-pending')}</Banner>
      ) : null}
      {showsInForce ? (
        <SettingsSection title={t('certification.status.in-force')}>
          <div className="px-5 py-4">
            <DataList rows={inForceRows(t, inForce, day)} missing={t('certification.list.none')} />
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection
        title={
          showsInForce
            ? t('certification.status.renewal-details')
            : t('certification.status.submitted-details')
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <DataList
            rows={
              approvedValues && inForce !== null
                ? inForceRows(t, inForce, day)
                : draftRows(t, detail.draft, detail, type, day)
            }
            missing={t('certification.list.none')}
          />
          {timeLine === null ? null : <p className="text-sm text-fg-muted">{timeLine}</p>}
        </div>
      </SettingsSection>
      {history.length === 0 ? null : (
        <SettingsSection title={t('certification.history.title')}>
          <ol className="flex flex-col gap-2 px-5 py-4 text-sm" data-testid="certificate-history">
            {history.map((entry, index) => (
              <HistoryLine key={`${entry.event}-${entry.at}-${index}`} entry={entry} zone={zone} />
            ))}
          </ol>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}

function ActionButton({
  action,
  href,
  blocked,
  reasonId,
  onWithdraw,
  label,
}: {
  readonly action: CertificateAction;
  readonly href: string;
  readonly blocked: boolean;
  readonly reasonId: string | undefined;
  readonly onWithdraw: () => void;
  readonly label: string;
}) {
  const variant = action.primary ? 'primary' : 'secondary';
  if (blocked || action.kind === 'withdraw') {
    // A button that can't be used stays focusable and names its reason (ux.md 272).
    return (
      <Button
        variant={variant}
        softDisabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={blocked ? undefined : onWithdraw}
      >
        {label}
      </Button>
    );
  }
  return (
    <LinkButton variant={variant} href={href}>
      {label}
    </LinkButton>
  );
}

/** The reason of a decision: the Market's words, the next step and the reviewer's note, inert. */
function DecisionReason({
  decision,
  t,
}: {
  readonly decision: CertificateDecision;
  readonly t: Translate;
}) {
  const key = decision.nextStep === null ? null : nextStepKey(decision.nextStep);
  const nextStep = key === null ? null : t(key);
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="decision-reason">
      {decision.reasonLabel === null ? null : (
        <p dir="auto" className="font-medium">
          {decision.reasonLabel}
        </p>
      )}
      {nextStep === null ? null : <p>{nextStep}</p>}
      {decision.reasonText === null || decision.reasonText.trim() === '' ? null : (
        // The reviewer's note is plain text: React renders it as text, never as markup or links.
        <blockquote
          dir="auto"
          className="whitespace-pre-line border-s-2 border-current ps-3 text-fg-secondary"
        >
          {t('certification.status.quote', { text: decision.reasonText })}
        </blockquote>
      )}
    </div>
  );
}

function HistoryLine({
  entry,
  zone,
}: {
  readonly entry: CertificateHistoryEntry;
  /** The day is the seller's, as on "Submitted on" (UTC when the zone is not known). */
  readonly zone: string | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const date = new Date(entry.at);
  const when = Number.isNaN(date.getTime())
    ? entry.at
    : format.dateTime(date, { dateStyle: 'medium', timeZone: zone ?? 'UTC' });
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-fg-muted" aria-hidden>
        <Icon name="clock" />
      </span>
      <span className="font-medium text-fg">{t(`certification.history.${entry.event}`)}</span>
      <time dateTime={entry.at} className="text-fg-muted">
        {when}
      </time>
      {entry.reasonLabel === null ? null : (
        <span dir="auto" className="basis-full ps-6 text-fg-secondary">
          {entry.reasonLabel}
        </span>
      )}
    </li>
  );
}

type Day = (value: string | null) => string | null;

function inForceRows(t: Translate, inForce: CertificateInForce, day: Day) {
  return [
    { label: t('certification.form.issuer.label'), value: inForce.issuerName },
    {
      label: t('certification.form.number.label'),
      value:
        inForce.certificateNumber === null ? null : (
          <span dir="ltr">{inForce.certificateNumber}</span>
        ),
    },
    { label: t('certification.form.issue-date.label'), value: day(inForce.issueDate) },
    { label: t('certification.form.expiry-date.label'), value: day(inForce.expiryDate) },
  ];
}

function draftRows(
  t: Translate,
  draft: CertificateDraft,
  detail: CertificateDetail,
  type: CertificateTypeOption | undefined,
  day: Day,
): { readonly label: string; readonly value: ReactNode | null }[] {
  const issuer =
    type?.issuers.find((item) => item.issuerId === draft.issuerId)?.displayName ??
    detail.certificate.issuerName ??
    null;
  const documents = orderedDocuments(detail.documents);
  const rows: { readonly label: string; readonly value: ReactNode | null }[] = [];
  if (type?.verificationMode === 'SELF_DECLARATION') {
    rows.push({
      label: t('certification.form.declaration.label'),
      value: draft.selfDeclared === true ? t('certification.status.declared') : null,
    });
    if (draft.selfDeclarationNote !== null) {
      rows.push({
        label: t('certification.form.declaration.note'),
        value: <span dir="auto">{draft.selfDeclarationNote}</span>,
      });
    }
  } else {
    if (type === undefined || type.requiresIssuerRegistry) {
      rows.push({ label: t('certification.form.issuer.label'), value: issuer });
    }
    rows.push({
      label: t('certification.form.number.label'),
      value:
        draft.certificateNumber === null ? null : <span dir="ltr">{draft.certificateNumber}</span>,
    });
    rows.push({ label: t('certification.form.issue-date.label'), value: day(draft.issueDate) });
  }
  if (type === undefined || type.requiresExpiry) {
    rows.push({ label: t('certification.form.expiry-date.label'), value: day(draft.expiryDate) });
  }
  if (documents.length > 0) {
    rows.push({
      label: t('certification.upload.title'),
      value: (
        <ul className="flex flex-col gap-1">
          {documents.map((document, index) => (
            <li key={document.documentId}>
              {[
                t('certification.upload.page', { number: index + 1 }),
                mediaLabel(document.mediaType),
                document.pageCount === null
                  ? null
                  : t('certification.upload.pages', { count: document.pageCount }),
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </li>
          ))}
        </ul>
      ),
    });
  }
  return rows;
}
