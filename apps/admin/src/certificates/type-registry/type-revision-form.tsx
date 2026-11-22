'use client';

import {
  Banner,
  Button,
  Dialog,
  SaveBar,
  TextAreaField,
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
import {
  DEFAULT_BASES,
  DESCRIPTION_MAX,
  ErrorSummary,
  NAME_MAX,
  RulesFields,
  TERMS_MAX,
  TERM_MAX,
  WordingFields,
  normaliseRules,
  termsOf,
  type LocaleDraft,
  type RulesDraft,
} from './type-fields.tsx';

const ICON_KEY = /^[a-z][a-z0-9-]{0,63}$/;

interface Draft extends RulesDraft {
  locales: Readonly<Record<string, LocaleDraft>>;
  reason: string;
}

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
    ...normaliseRules(content.verificationMode ?? '', {
      requiresIssuerRegistry: content.requiresIssuerRegistry === true,
      requiresDocument: content.requiresDocument === true,
      requiresExpiry: content.requiresExpiry === true,
      defaultBasis: content.defaultBasis ?? 'NOT_APPLICABLE',
      // Only a self-declared type shows the switch; any other type never auto-approves.
      autoApprove:
        content.verificationMode === 'SELF_DECLARATION' &&
        content.autoApproveSelfDeclaration === true,
      icon: content.badgeIconKey ?? '',
    }),
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
    ...(() => {
      const rules = normaliseRules(published.verificationMode ?? '', draft);
      return {
        requiresIssuerRegistry: rules.requiresIssuerRegistry,
        requiresDocument: rules.requiresDocument,
        requiresExpiry: rules.requiresExpiry,
        defaultBasis: rules.defaultBasis,
        autoApproveSelfDeclaration:
          published.verificationMode === 'SELF_DECLARATION' ? rules.autoApprove : false,
        badgeIconKey: rules.icon.trim(),
      };
    })(),
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
  artworkKeys = [],
}: {
  readonly type: TypeDetail;
  readonly csrfToken: string;
  /** The artwork the API lists (new-options); the key the type has stays choosable. */
  readonly artworkKeys?: readonly string[];
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
  const [focusKey, setFocusKey] = useState(0);
  // Set once the revision is saved and the browser is sent on: the leave prompt stays quiet.
  const [leaving, setLeaving] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const selfDeclared = published.verificationMode === 'SELF_DECLARATION';
  const problems = problemsOf(draft, selfDeclared);
  const failed = Object.keys(problems).length > 0;
  const yesNo = (value: boolean) => td(value ? 'yes' : 'no');
  const basis = (value: string) => (tb.has(value as never) ? tb(value as never) : value);
  // What the method forces (a document for an issuer certificate) is the baseline, so a seed type
  // stored without it opens clean.
  const forced = normaliseRules(published.verificationMode ?? '', {
    requiresIssuerRegistry: published.requiresIssuerRegistry === true,
    requiresDocument: published.requiresDocument === true,
    requiresExpiry: published.requiresExpiry === true,
    defaultBasis: published.defaultBasis ?? 'NOT_APPLICABLE',
    autoApprove: published.autoApproveSelfDeclaration === true,
    icon: published.badgeIconKey ?? '',
  });
  const changes = changesOf(
    {
      ...published,
      requiresIssuerRegistry: forced.requiresIssuerRegistry,
      requiresDocument: forced.requiresDocument,
    },
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
    if (failed) setFocusKey((key) => key + 1);
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
      const what =
        answer.body.outcome === 'published'
          ? 'revision-published'
          : answer.body.outcome === 'proposal-revised'
            ? 'proposal-changed'
            : 'revision-pending';
      flushSync(() => setLeaving(true));
      window.location.assign(`/certificates/types/${type.typeId}?done=${what}`);
    }
  }

  const summaryItems = shown
    ? Object.keys(problems).flatMap((key) => {
        const text = error(key, key === 'terms' ? 'terms-missing' : key.split('-')[0]!);
        const field = key === 'terms' ? `terms-${Object.keys(draft.locales)[0] ?? ''}` : key;
        return text === undefined ? [] : [{ field, text }];
      })
    : [];
  return (
    <form onSubmit={review} className="flex flex-col gap-6" noValidate>
      <p className="text-fg-muted">{t('intro')}</p>
      <ErrorSummary items={summaryItems} focusKey={focusKey} />
      <RulesFields
        variant="edit"
        mode={published.verificationMode ?? ''}
        value={draft}
        onChange={set}
        artworkKeys={artworkKeys}
        bases={DEFAULT_BASES}
        errors={{ icon: error('icon', 'icon') }}
        lead={
          <p className="text-sm">
            <span className="text-fg-muted">{td('mode')}: </span>
            {published.verificationMode !== undefined && tm.has(published.verificationMode as never)
              ? tm(published.verificationMode as never)
              : (published.verificationMode ?? td('none'))}
            <span className="text-fg-muted"> · {t('mode-fixed')}</span>
          </p>
        }
      />
      <WordingFields
        variant="edit"
        locales={draft.locales}
        onChange={setLocale}
        errors={Object.fromEntries(
          Object.keys(problems).map((key) => [
            key,
            error(key, key === 'terms' ? 'terms-missing' : key.split('-')[0]!),
          ]),
        )}
      />
      <TextAreaField
        label={t('reason')}
        optionalLabel={t('optional')}
        rows={3}
        value={draft.reason}
        onChange={(event) => set({ reason: event.target.value })}
        help={t('reason-help', { max: REASON_MAX })}
        dir="auto"
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
