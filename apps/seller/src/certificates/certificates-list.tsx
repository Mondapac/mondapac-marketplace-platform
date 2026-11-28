'use client';

import {
  Button,
  CARD_TABLE,
  EmptyState,
  Banner,
  LinkButton,
  SettingsPage,
  SettingsViewOnlyBanner,
} from '@mondapac/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { zonePlace } from './certificate-form.tsx';
import { formatDay, formatInstantDay } from './format.ts';
import { SellerAccountLine } from './seller-account-line.tsx';
import { StartCertificateDialog } from './start-dialog.tsx';
import {
  blocksNewOfType,
  expiryToneOf,
  formPathOf,
  mostUrgentExpiry,
  rowActionKey,
  sortForList,
} from './status.ts';
import { CertificateStatusBadge } from './status-badge.tsx';
import {
  certificatePath,
  typeName,
  type CertificateList,
  type CertificateOptions,
  type CertificateSummary,
  type SellerAccountState,
} from './types.ts';

/** The row button: the sticky end column on a wide screen, a full-width last line on a card. */
const ROW_BUTTON_CELL =
  'px-4 py-3 text-end align-top max-lg:col-span-full max-lg:p-0 max-lg:pt-2 max-lg:text-start lg:sticky lg:end-0 lg:z-10 lg:bg-surface';

/**
 * Settings › Certificates (design section 5, CS1): the header (title and Add on one row, no
 * subtitle), the seller account's own state on a line of its own (CERT-12), and one row per
 * certificate, the ones that need work first. The type name links to the certificate; the row's
 * button is separate, the row itself is not a button.
 */
export function CertificatesList({
  list,
  options,
  account,
  canManage,
  zone,
  csrfToken,
  startOpen = false,
}: {
  readonly list: CertificateList;
  readonly options: CertificateOptions;
  readonly account: SellerAccountState;
  readonly canManage: boolean;
  /** The seller's working zone, for "Last changed"; null when it could not be read. */
  readonly zone: string | null;
  readonly csrfToken: string;
  /** Open the start dialog at once ("Add a certificate" from a declined or revoked one). */
  readonly startOpen?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const format = useFormatter();
  const [starting, setStarting] = useState(startOpen);
  const viewOnlyId = useId();
  const noTypesId = useId();
  const rows = useMemo(() => sortForList(list.certificates), [list.certificates]);
  const names = useMemo(
    () =>
      new Map(options.types.map((type) => [type.code, typeName(type.names, type.code, locale)])),
    [options.types, locale],
  );
  const nameOf = (code: string) => names.get(code) ?? code;
  const blocking = useMemo(() => {
    const open = new Map<string, CertificateSummary>();
    for (const row of list.certificates) {
      if (blocksNewOfType(row) && !open.has(row.typeCode)) open.set(row.typeCode, row);
    }
    return open;
  }, [list.certificates]);
  const noTypes = options.types.length === 0;
  const addBlocked = !canManage || noTypes;
  const expiring = mostUrgentExpiry(list.certificates);
  const addReason = !canManage ? viewOnlyId : noTypes ? noTypesId : undefined;

  const add = (
    <Button
      softDisabled={addBlocked}
      // One name at every width: the phone shows the short word to keep the header on one row.
      aria-label={t('certification.action.add')}
      aria-describedby={addReason}
      onClick={addBlocked ? undefined : () => setStarting(true)}
    >
      <span className="max-sm:hidden">{t('certification.action.add')}</span>
      <span className="sm:hidden">{t('certification.action.add-short')}</span>
    </Button>
  );

  const banners = [
    canManage ? null : (
      <div key="view-only" id={viewOnlyId}>
        <SettingsViewOnlyBanner title={t('settings.view-only.title')}>
          {t('certification.view-only.ask-owner')}
        </SettingsViewOnlyBanner>
      </div>
    ),
    expiring === null ? null : (
      <ExpiryBanner
        key="expiry"
        certificate={expiring}
        type={nameOf(expiring.typeCode)}
        zone={zone}
        canManage={canManage}
        day={(value) => formatDay((date, o) => format.dateTime(date, o), value)}
      />
    ),
    canManage && noTypes ? (
      <p key="no-types" id={noTypesId} className="text-sm text-fg-muted">
        {t('certification.add.none')}
      </p>
    ) : null,
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t('certification.seller.title')}
      actions={add}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
    >
      <SellerAccountLine account={account} />
      <section
        aria-label={t('certification.seller.title')}
        className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface"
      >
        {rows.length === 0 ? (
          <EmptyState
            icon="shield-check"
            title={t('certification.seller.empty')}
            body={t('certification.empty.hint')}
          />
        ) : (
          <CertificateRows rows={rows} nameOf={nameOf} zone={zone} />
        )}
      </section>
      {starting && !addBlocked ? (
        <StartCertificateDialog
          open
          types={options.types}
          blocking={blocking}
          csrfToken={csrfToken}
          onClose={() => setStarting(false)}
        />
      ) : null}
    </SettingsPage>
  );
}

function CertificateRows({
  rows,
  nameOf,
  zone,
}: {
  readonly rows: readonly CertificateSummary[];
  readonly nameOf: (code: string) => string;
  readonly zone: string | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const dateTime = (value: Date, options: { dateStyle: 'medium'; timeZone: string }) =>
    format.dateTime(value, options);
  const none = t('certification.list.none');
  const columns = {
    certificate: t('certification.list.certificate'),
    status: t('certification.list.status'),
    issuer: t('certification.list.issuer'),
    validUntil: t('certification.list.valid-until'),
    lastChanged: t('certification.list.last-changed'),
    actions: t('certification.list.actions'),
  };
  return (
    <div className="lg:overflow-x-auto">
      <table className={CARD_TABLE.table}>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 text-start font-medium">
              {columns.certificate}
            </th>
            <th scope="col" className="px-4 py-3 text-start font-medium">
              {columns.status}
            </th>
            <th scope="col" className="px-4 py-3 text-start font-medium">
              {columns.issuer}
            </th>
            <th scope="col" className="px-4 py-3 text-start font-medium">
              {columns.validUntil}
            </th>
            <th scope="col" className="px-4 py-3 text-start font-medium">
              {columns.lastChanged}
            </th>
            <th scope="col" className={CARD_TABLE.actionsHead}>
              <span className="sr-only">{columns.actions}</span>
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => {
            const name = nameOf(row.typeCode);
            const action = rowActionKey(row);
            const validUntil = formatDay(dateTime, row.validUntil) ?? none;
            return (
              <tr key={row.certificateId} className={CARD_TABLE.row}>
                <th scope="row" className={`${CARD_TABLE.cell} text-start font-medium`}>
                  <Link
                    href={certificatePath(row.certificateId)}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {name}
                  </Link>
                </th>
                <td className={CARD_TABLE.corner}>
                  <CertificateStatusBadge status={row.status} />
                </td>
                <td className={CARD_TABLE.labelled} data-label={columns.issuer}>
                  <span>{row.issuerName ?? none}</span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={columns.validUntil}>
                  <span>{validUntil}</span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={columns.lastChanged}>
                  <time dateTime={row.lastChangedAt}>
                    {formatInstantDay(dateTime, row.lastChangedAt, zone)}
                  </time>
                </td>
                {/* A phone card puts the button on its own line at the end: a long label beside the
                  name and status would squeeze the name out of the card's first line. */}
                <td className={ROW_BUTTON_CELL}>
                  {action === null ? null : (
                    <Link
                      href={formPathOf(row)}
                      aria-label={`${t(action)}: ${name}`}
                      className="inline-flex h-(--mp-size-control-sm) items-center whitespace-nowrap rounded-md border border-line-control bg-surface px-3 text-sm font-medium text-fg hover:bg-muted"
                    >
                      {t(action)}
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The expiry banner (design 5.1): the API sets its tone (info from the first warning, attention
 * from a later one, critical on the last day and once expired) and both dates; the panel counts
 * nothing. Only the most urgent certificate gets one.
 */
export function ExpiryBanner({
  certificate,
  type,
  zone,
  canManage,
  day,
}: {
  readonly certificate: CertificateSummary;
  readonly type: string;
  readonly zone: string | null;
  readonly canManage: boolean;
  readonly day: (value: string | null | undefined) => string | null;
}) {
  const t = useTranslations();
  const tone = expiryToneOf(certificate);
  if (tone === null) return null;
  const date = day(certificate.validUntil) ?? t('certification.list.none');
  const submitBy = day(certificate.renewalSubmitBy);
  const zoneName =
    zone === null
      ? t('certification.status.your-time')
      : t('certification.form.zone-time', { place: zonePlace(zone) });
  const expired = certificate.status === 'expired';
  const title = expired
    ? t('certification.expired.title')
    : t('certification.expiring.title-type', { type, date });
  const body = expired
    ? t('certification.expired.body')
    : submitBy === null
      ? t('certification.expiring.body-plain', { date, zoneName })
      : t('certification.expiring.body', { date, zoneName, submitBy });
  return (
    <div data-testid="expiry-banner" data-tone={tone}>
      <Banner tone={tone} title={title}>
        <p>{body}</p>
        {canManage ? (
          <p className="mt-2">
            <LinkButton
              variant="secondary"
              href={formPathOf(certificate)}
              aria-label={`${t('certification.action.renew')}: ${type}`}
            >
              {t('certification.action.renew')}
            </LinkButton>
          </p>
        ) : null}
      </Banner>
    </div>
  );
}
