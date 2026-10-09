import { Badge, Banner, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { SETUP_ROOT, SETUP_STEPS, type SetupStepKey } from './steps.ts';
import { SubmitButton } from './submit-button.tsx';
import type { FormDescriptors, MissingPart, MyFile } from './types.ts';

interface Row {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly step: SetupStepKey;
  readonly missing: boolean;
  readonly blocked: boolean;
}

function hrefOf(step: SetupStepKey): string {
  return SETUP_STEPS.find((candidate) => candidate.key === step)?.href ?? SETUP_ROOT;
}

/** S6: every saved value with an Edit link, what is missing or blocked, and the one submit action. */
export function ReviewSubmit({
  file,
  descriptors,
  csrfToken,
}: {
  readonly file: MyFile;
  readonly descriptors: FormDescriptors;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const gone = (part: MissingPart) => file.missing.includes(part);
  const outside = file.outsideServiceArea === true;
  const identifierLabel = t.has(descriptors.identifier.labelKey)
    ? t(descriptors.identifier.labelKey)
    : t('sellers.number.title');
  const addressText = (address: Readonly<Record<string, string>> | null): string | null => {
    if (address === null) return null;
    const parts = descriptors.address.fields
      .map((field) => address[field.key]?.trim() ?? '')
      .filter((part) => part !== '');
    return parts.length === 0 ? null : parts.join(', ');
  };
  const rows: readonly Row[] = [
    {
      key: 'storeName',
      label: t('sellers.business.label.store-name'),
      value: file.general.storeName,
      step: 'business',
      missing: gone('storeName'),
      blocked: false,
    },
    {
      key: 'businessName',
      label: t('sellers.business.label.business-name'),
      value: file.general.businessName,
      step: 'business',
      missing: gone('businessName'),
      blocked: false,
    },
    {
      key: 'phone',
      label: t('sellers.business.label.phone'),
      value: file.general.phone,
      step: 'business',
      missing: gone('phone'),
      blocked: false,
    },
    {
      key: 'contactEmail',
      label: t('sellers.business.label.contact-email'),
      value: file.general.contactEmail,
      step: 'business',
      missing: false,
      blocked: false,
    },
    {
      key: 'address',
      label: t('sellers.submit.label.address'),
      value: addressText(file.address),
      step: 'address',
      missing: gone('address'),
      blocked: outside,
    },
    ...(addressText(file.registeredAddress) === null
      ? []
      : [
          {
            key: 'registered',
            label: t('sellers.submit.label.registered'),
            value: addressText(file.registeredAddress),
            step: 'address' as const,
            missing: false,
            blocked: false,
          },
        ]),
    {
      key: 'timezone',
      label: t('sellers.submit.label.zone'),
      value: file.timezone?.operatingTimezone ?? null,
      step: 'address',
      missing: gone('timezone'),
      blocked: false,
    },
    {
      key: 'identifier',
      label: identifierLabel,
      value: file.identifier?.display ?? null,
      step: 'number',
      missing: gone('identifier'),
      blocked: file.registerResult === 'not-matched',
    },
    {
      key: 'slug',
      label: t('sellers.slug.label'),
      value: file.slug,
      step: 'slug',
      missing: gone('slug'),
      blocked: false,
    },
  ];
  const problems = rows.filter((row) => row.missing || row.blocked);
  const first = problems[0];
  const waiting = file.status === 'awaiting-review';
  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Link href={SETUP_ROOT} className="text-sm font-medium text-link hover:underline">
          {t('sellers.step.back')}
        </Link>
        <h1 className="text-2xl font-semibold text-fg">{t('sellers.submit.title')}</h1>
      </header>
      <Banner tone="info">{t('sellers.submit.banner')}</Banner>
      {waiting ? <Banner tone="attention">{t('sellers.submit.locked')}</Banner> : null}
      {outside ? <Banner tone="attention">{t('sellers.submit.blocked-area')}</Banner> : null}
      <Card title={t('sellers.submit.details')}>
        <dl className="flex flex-col divide-y divide-line">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <dt className="text-sm text-fg-muted">{row.label}</dt>
                <dd className="break-words text-fg">
                  {row.value !== null && row.value !== '' ? (
                    row.value
                  ) : (
                    <span className="text-fg-muted">{t('sellers.submit.row.not-entered')}</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                {row.blocked ? (
                  <Badge tone="attention">{t('sellers.submit.row.blocked')}</Badge>
                ) : row.missing ? (
                  <Badge tone="attention">{t('sellers.submit.row.missing')}</Badge>
                ) : null}
                <Link
                  href={hrefOf(row.step)}
                  className="text-sm font-medium text-link hover:underline"
                >
                  {t('sellers.submit.row.edit')}
                  <span className="sr-only"> {row.label}</span>
                </Link>
              </div>
            </div>
          ))}
        </dl>
      </Card>
      {waiting ? null : (
        <div className="flex flex-col gap-2">
          <SubmitButton
            csrfToken={csrfToken}
            disabled={problems.length > 0}
            again={file.status === 'changes-needed'}
          />
          {first === undefined ? null : (
            <p className="text-sm text-fg-muted">
              <Link href={hrefOf(first.step)} className="text-link hover:underline">
                {t('sellers.submit.help.blocked', { count: problems.length })}
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
