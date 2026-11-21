'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  SaveBar,
  Select,
  TextAreaField,
  TextField,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  API_TYPES,
  REASON_MAX,
  type TypeContent,
  type TypeDetail,
  type TypeRevisionSaved,
} from './types.ts';
import { useTypeCall } from './use-type-call.ts';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const TERM_MAX = 100;
const TERMS_MAX = 200;
const ICON_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_BASES = ['SELLER_REQUIRED', 'NOT_APPLICABLE'] as const;

interface LocaleDraft {
  name: string;
  description: string;
  /** One term per line. */
  terms: string;
}

interface Draft {
  requiresIssuerRegistry: boolean;
  requiresDocument: boolean;
  requiresExpiry: boolean;
  defaultBasis: string;
  autoApprove: boolean;
  icon: string;
  locales: Readonly<Record<string, LocaleDraft>>;
  reason: string;
}

const termsOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

function draftOf(content: TypeContent): Draft {
  const locales: Record<string, LocaleDraft> = {};
  for (const [code, text] of Object.entries(content.locales ?? {})) {
    locales[code] = {
      name: text.name ?? '',
      description: text.customerDescription ?? '',
      terms: (text.claimTerms ?? []).join('\n'),
    };
  }
  return {
    requiresIssuerRegistry: content.requiresIssuerRegistry === true,
    requiresDocument: content.requiresDocument === true,
    requiresExpiry: content.requiresExpiry === true,
    defaultBasis: content.defaultBasis ?? 'NOT_APPLICABLE',
    // Only a self-declared type shows the switch; any other type never auto-approves.
    autoApprove:
      content.verificationMode === 'SELF_DECLARATION' &&
      content.autoApproveSelfDeclaration === true,
    icon: content.badgeIconKey ?? '',
    locales,
    reason: '',
  };
}

/** The content sent to the API: the check method is carried over from the published revision. */
function contentOf(published: TypeContent, draft: Draft): Record<string, unknown> {
  const locales: Record<string, unknown> = {};
  for (const [code, text] of Object.entries(draft.locales)) {
    locales[code] = {
      name: text.name.trim(),
      customerDescription: text.description.trim(),
      claimTerms: termsOf(text.terms),
    };
  }
  return {
    verificationMode: published.verificationMode,
    requiresIssuerRegistry: draft.requiresIssuerRegistry,
    requiresDocument: draft.requiresDocument,
    requiresExpiry: draft.requiresExpiry,
    defaultBasis: draft.defaultBasis,
    autoApproveSelfDeclaration:
      published.verificationMode === 'SELF_DECLARATION' ? draft.autoApprove : false,
    badgeIconKey: draft.icon.trim(),
    locales,
  };
}

interface Change {
  readonly key: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/** What the admin changed, for the confirmation. The API decides what needs a second admin. */
function changesOf(
  published: TypeContent,
  draft: Draft,
  label: (key: string, values?: Record<string, string>) => string,
  yesNo: (value: boolean) => string,
  basis: (value: string) => string,
): Change[] {
  const out: Change[] = [];
  const flag = (key: string, labelKey: string, before: boolean | undefined, after: boolean) => {
    if ((before === true) !== after)
      out.push({
        key,
        label: label(labelKey),
        before: yesNo(before === true),
        after: yesNo(after),
      });
  };
  flag('issuer', 'needs-issuer', published.requiresIssuerRegistry, draft.requiresIssuerRegistry);
  flag('document', 'needs-document', published.requiresDocument, draft.requiresDocument);
  flag('expiry', 'needs-expiry', published.requiresExpiry, draft.requiresExpiry);
  if (published.verificationMode === 'SELF_DECLARATION')
    flag('auto', 'auto-approve', published.autoApproveSelfDeclaration, draft.autoApprove);
  if ((published.defaultBasis ?? 'NOT_APPLICABLE') !== draft.defaultBasis)
    out.push({
      key: 'basis',
      label: label('default-basis'),
      before: basis(published.defaultBasis ?? 'NOT_APPLICABLE'),
      after: basis(draft.defaultBasis),
    });
  if ((published.badgeIconKey ?? '') !== draft.icon.trim())
    out.push({
      key: 'icon',
      label: label('icon'),
      before: published.badgeIconKey ?? '-',
      after: draft.icon.trim(),
    });
  for (const [code, text] of Object.entries(draft.locales)) {
    const was = published.locales?.[code];
    if ((was?.name ?? '') !== text.name.trim())
      out.push({
        key: `name-${code}`,
        label: label('locale-name-in', { locale: code }),
        before: was?.name ?? '-',
        after: text.name.trim(),
      });
    if ((was?.customerDescription ?? '') !== text.description.trim())
      out.push({
        key: `description-${code}`,
        label: label('locale-description-in', { locale: code }),
        before: was?.customerDescription ?? '-',
        after: text.description.trim(),
      });
    const before = was?.claimTerms ?? [];
    const after = termsOf(text.terms);
    const added = after.filter((term) => !before.includes(term));
    const removed = before.filter((term) => !after.includes(term));
    if (added.length > 0 || removed.length > 0)
      out.push({
        key: `terms-${code}`,
        label: label('locale-terms-in', { locale: code }),
        before: removed.length === 0 ? '-' : removed.join(', '),
        after: added.length === 0 ? '-' : added.join(', '),
      });
  }
  return out;
}

/** Per-field problems of the form, as message keys under `certificates.types.revise.problem`. */
function problemsOf(draft: Draft, autoApproveAllowed: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ICON_KEY.test(draft.icon.trim())) out.icon = 'icon';
  if (draft.autoApprove && !autoApproveAllowed) out.auto = 'auto';
  if (draft.reason.trim().length > REASON_MAX) out.reason = 'reason';
  let anyTerm = false;
  for (const [code, text] of Object.entries(draft.locales)) {
    const name = text.name.trim();
    const description = text.description.trim();
    const terms = termsOf(text.terms);
    if (name === '' || name.length > NAME_MAX) out[`name-${code}`] = 'name';
    if (description === '' || description.length > DESCRIPTION_MAX)
      out[`description-${code}`] = 'description';
    if (terms.length > TERMS_MAX || terms.some((term) => term.length > TERM_MAX))
      out[`terms-${code}`] = 'terms';
    if (terms.length > 0) anyTerm = true;
  }
  if (!anyTerm) out.terms = 'terms-missing';
  return out;
}

/**
 * The form that writes a new revision of one certificate type (certificates design CA4). The
 * check method never changes. Saving asks first and shows what changes; whether the revision is
 * published or waits for a second admin is the API's answer, shown after the redirect.
 */
export function TypeRevisionForm({
  type,
  csrfToken,
}: {
  readonly type: TypeDetail;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.types.revise');
  const td = useTranslations('certificates.types.detail');
  const tb = useTranslations('certificates.types.basis');
  const tm = useTranslations('certificates.types.mode');
  const tr = useTranslations();
  const call = useTypeCall(csrfToken);
  const published = type.published.content;
  const [draft, setDraft] = useState<Draft>(() => draftOf(published));
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Set once the revision is saved and the browser is sent on: the leave prompt stays quiet.
  const [leaving, setLeaving] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const selfDeclared = published.verificationMode === 'SELF_DECLARATION';
  const problems = problemsOf(draft, selfDeclared);
  const failed = Object.keys(problems).length > 0;
  const yesNo = (value: boolean) => td(value ? 'yes' : 'no');
  const basis = (value: string) => (tb.has(value as never) ? tb(value as never) : value);
  const changes = changesOf(
    published,
    draft,
    (key, values) => td(key as never, values as never),
    yesNo,
    basis,
  );
  const error = (key: string, kind: string) =>
    shown && problems[key] !== undefined
      ? t(
          `problem.${kind}` as never,
          {
            nameMax: NAME_MAX,
            descriptionMax: DESCRIPTION_MAX,
            termMax: TERM_MAX,
            termsMax: TERMS_MAX,
            reasonMax: REASON_MAX,
          } as never,
        )
      : undefined;
  const count = changes.length;
  const errorCount = shown ? Object.keys(problems).length : 0;
  // Leaving with edits that are not saved asks first (the dialog the settings pages use).
  const guard = useUnsavedChangesGuard(
    count > 0 && !leaving,
    {
      title: tr('settings.leave.title'),
      message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
      stay: tr('settings.leave.stay'),
      leave: tr('settings.leave.leave'),
    },
    { count, page: t('title') },
  );
  function discard() {
    setDraft(draftOf(published));
    setShown(false);
  }
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setLocale = (code: string, patch: Partial<LocaleDraft>) =>
    setDraft((current) => ({
      ...current,
      locales: { ...current.locales, [code]: { ...current.locales[code]!, ...patch } },
    }));

  function review(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (failed || changes.length === 0) return;
    setConfirming(true);
  }

  async function save() {
    const why = draft.reason.trim();
    const answer = await call.run<TypeRevisionSaved>(`${API_TYPES}/${type.typeId}/revisions`, {
      version: type.version,
      content: contentOf(published, draft),
      ...(why === '' ? {} : { reason: why }),
    });
    if (answer.ok) {
      const what = answer.body.outcome === 'published' ? 'revision-published' : 'revision-pending';
      flushSync(() => setLeaving(true));
      window.location.assign(`/certificates/types/${type.typeId}?done=${what}`);
    }
  }

  const localeEntries = Object.entries(draft.locales);
  return (
    <form onSubmit={review} className="flex flex-col gap-6" noValidate>
      <p className="text-fg-muted">{t('intro')}</p>
      <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <legend className="px-1 text-base font-semibold">{t('settings')}</legend>
        <p className="text-sm">
          <span className="text-fg-muted">{td('mode')}: </span>
          {published.verificationMode !== undefined && tm.has(published.verificationMode as never)
            ? tm(published.verificationMode as never)
            : (published.verificationMode ?? td('none'))}
          <span className="text-fg-muted"> · {t('mode-fixed')}</span>
        </p>
        <CheckboxRow
          label={td('needs-issuer')}
          checked={draft.requiresIssuerRegistry}
          onChange={(event) => set({ requiresIssuerRegistry: event.target.checked })}
        />
        <CheckboxRow
          label={td('needs-document')}
          checked={draft.requiresDocument}
          onChange={(event) => set({ requiresDocument: event.target.checked })}
        />
        <CheckboxRow
          label={td('needs-expiry')}
          checked={draft.requiresExpiry}
          onChange={(event) => set({ requiresExpiry: event.target.checked })}
        />
        <Select
          label={td('default-basis')}
          value={draft.defaultBasis}
          onChange={(event) => set({ defaultBasis: event.target.value })}
          options={DEFAULT_BASES.map((value) => ({ value, label: basis(value) }))}
        />
        {selfDeclared ? (
          <CheckboxRow
            label={td('auto-approve')}
            help={t('auto-help')}
            checked={draft.autoApprove}
            onChange={(event) => set({ autoApprove: event.target.checked })}
          />
        ) : null}
        <TextField
          label={td('icon')}
          value={draft.icon}
          onChange={(event) => set({ icon: event.target.value })}
          help={t('icon-help')}
          error={error('icon', 'icon')}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
        />
      </fieldset>
      {localeEntries.map(([code, text]) => (
        <fieldset
          key={code}
          lang={code}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <legend className="px-1 text-base font-semibold">{td('locale', { locale: code })}</legend>
          <TextField
            label={td('locale-name')}
            value={text.name}
            onChange={(event) => setLocale(code, { name: event.target.value })}
            error={error(`name-${code}`, 'name')}
            help={t('name-help', { max: NAME_MAX })}
          />
          <TextAreaField
            label={td('locale-description')}
            rows={3}
            value={text.description}
            onChange={(event) => setLocale(code, { description: event.target.value })}
            error={error(`description-${code}`, 'description')}
            help={t('description-help', { max: DESCRIPTION_MAX })}
          />
          <TextAreaField
            label={td('locale-terms')}
            rows={6}
            value={text.terms}
            onChange={(event) => setLocale(code, { terms: event.target.value })}
            error={error(`terms-${code}`, 'terms') ?? error('terms', 'terms-missing')}
            help={t('terms-help', { term: TERM_MAX, terms: TERMS_MAX })}
          />
        </fieldset>
      ))}
      <TextAreaField
        label={t('reason')}
        optionalLabel={t('optional')}
        rows={3}
        value={draft.reason}
        onChange={(event) => set({ reason: event.target.value })}
        help={t('reason-help', { max: REASON_MAX })}
        error={error('reason', 'reason')}
      />
      <SaveBar
        count={count}
        summary={tr('settings.bar.summary', { count })}
        errorCount={errorCount}
        errorsSummary={tr('settings.bar.errors', { count: errorCount })}
        labels={{
          region: tr('settings.bar.region'),
          discard: tr('settings.bar.discard'),
          // Save opens the confirmation that lists the changes; nothing is sent yet.
          save: t('review'),
          saving: t('review'),
        }}
        onDiscard={discard}
      />
      {guard.dialog}
      {confirming ? (
        <Dialog
          open
          title={t('confirm.title')}
          onClose={() => {
            if (!call.pending) setConfirming(false);
          }}
          initialFocus={cancel}
          actions={
            <>
              <Button
                ref={cancel}
                variant="secondary"
                disabled={call.pending}
                onClick={() => setConfirming(false)}
              >
                {t('confirm.back')}
              </Button>
              {call.problem?.reload === true ? (
                <Button
                  type="button"
                  autoFocus
                  onClick={() => {
                    // The draft is stale: reloading is the way out, so the leave prompt stays quiet.
                    flushSync(() => setLeaving(true));
                    window.location.reload();
                  }}
                >
                  {t('confirm.reload')}
                </Button>
              ) : (
                <Button loading={call.pending} disabled={call.pending} onClick={() => void save()}>
                  {t('confirm.save')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <div aria-live="polite" className="flex flex-col gap-2">
              {call.problem === null ? null : (
                <Banner tone="critical">{tr(call.problem.key)}</Banner>
              )}
              {call.problem === null || call.problem.issues.length === 0 ? null : (
                <ul className="list-disc ps-5 text-sm">
                  {call.problem.issues.map((key) => (
                    <li key={key}>{t(`issue.${key}` as never)}</li>
                  ))}
                </ul>
              )}
            </div>
            <p>{t('confirm.body')}</p>
            <ul className="flex flex-col gap-2">
              {changes.map((change) => (
                <li key={change.key} className="text-sm wrap-anywhere">
                  <span className="font-medium">{change.label}</span>
                  <br />
                  <span className="text-fg-muted">{t('confirm.from')}</span> {change.before}
                  <br />
                  <span className="text-fg-muted">{t('confirm.to')}</span> {change.after}
                </li>
              ))}
            </ul>
            <Banner tone="info">{t('confirm.second-admin')}</Banner>
          </div>
        </Dialog>
      ) : null}
    </form>
  );
}
