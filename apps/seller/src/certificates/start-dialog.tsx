'use client';

import { Banner, Button, Dialog, RadioGroup } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { certificateProblemOf } from './errors.ts';
import {
  certificatePath,
  typeName,
  type CertificateSummary,
  type CertificateTypeOption,
} from './types.ts';

/**
 * "Add a certificate" (design section 6, CS2): one choice and Start, which creates the draft on
 * the server and opens its form. A type that already has an open certificate cannot be chosen;
 * the dialog links to that certificate instead.
 */
export function StartCertificateDialog({
  open,
  types,
  blocking,
  csrfToken,
  onClose,
}: {
  readonly open: boolean;
  readonly types: readonly CertificateTypeOption[];
  /** The open certificate of each type that has one (type code to the certificate). */
  readonly blocking: ReadonlyMap<string, CertificateSummary>;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const free = types.filter((type) => !blocking.has(type.code));
  const [choice, setChoice] = useState<string>(free[0]?.code ?? '');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const nameOf = (type: CertificateTypeOption) => typeName(type.names, type.code, locale);

  async function start() {
    if (busy.current || choice === '') return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<CertificateSummary>(
      'POST',
      'certification/seller/certificates',
      { typeCode: choice },
      csrfToken,
    );
    if (result.ok) {
      router.push(certificatePath(result.body.certificateId));
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const chosen = types.find((type) => type.code === choice);
    const found = certificateProblemOf(result.failure);
    setProblem(t(found.key, { type: chosen === undefined ? choice : nameOf(chosen) }));
    // Another tab started one, or the type was closed: the list behind shows the latest state.
    if (found.then !== undefined || result.failure.code === 'certificate.exists') router.refresh();
  }

  return (
    <Dialog
      open={open}
      title={t('certification.add.title')}
      onClose={pending ? () => undefined : onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('certification.action.cancel')}
          </Button>
          <Button
            onClick={() => void start()}
            loading={pending}
            disabled={choice === '' || free.length === 0}
          >
            {t('certification.add.start')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem === null ? null : (
          <div aria-live="polite">
            <Banner tone="critical">{problem}</Banner>
          </div>
        )}
        {free.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('certification.add.all-open')}</p>
        ) : (
          <RadioGroup
            legend={t('certification.add.choose.help')}
            name="certificate-type"
            value={choice}
            onChange={setChoice}
            disabled={pending}
            options={free.map((type) => ({
              value: type.code,
              label: nameOf(type),
              help: needsLine(t, type),
            }))}
          />
        )}
        {[...blocking.entries()].map(([code, certificate]) => {
          const type = types.find((item) => item.code === code);
          if (type === undefined) return null;
          return (
            <p key={code} className="text-sm text-fg-muted">
              <span className="font-medium text-fg">{nameOf(type)}</span>
              {' · '}
              {t('certification.add.exists', { type: nameOf(type) })}{' '}
              <Link
                href={certificatePath(certificate.certificateId)}
                className="font-medium text-link underline"
              >
                {t('certification.add.open-it')}
              </Link>
            </p>
          );
        })}
      </div>
    </Dialog>
  );
}

/** What the type asks for, from its form settings (design section 6, sample 3). */
export function needsLine(
  t: (key: string, values?: Record<string, string>) => string,
  type: CertificateTypeOption,
): string {
  if (type.verificationMode === 'SELF_DECLARATION') return t('certification.add.needs-self');
  return t('certification.add.needs', {
    issuer: type.requiresIssuerRegistry ? 'yes' : 'no',
    expiry: type.requiresExpiry ? 'yes' : 'no',
    document: type.requiresDocument ? 'yes' : 'no',
  });
}
