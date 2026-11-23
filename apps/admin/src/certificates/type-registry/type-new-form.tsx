'use client';

import {
  Button,
  LinkButton,
  RadioGroup,
  TextAreaField,
  TextField,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  ErrorSummary,
  RulesFields,
  WordingFields,
  normaliseRules,
  termsOf,
  TEXT_ARTWORK,
  type LocaleDraft,
  type RulesDraft,
} from './type-fields.tsx';
import { TypeReviewDialog, type NewTypeSummary } from './type-review-dialog.tsx';
import { API_TYPES, type TypeCreated, type TypeNewOptions } from './types.ts';
import { useTypeCall } from './use-type-call.ts';

const CODE_START = /^[a-z]/;
const CODE_CHARS = /^[a-z0-9-]*$/;
const ICON_KEY = /^[a-z][a-z0-9-]{0,63}$/;

interface Draft {
  code: string;
  mode: string;
  rules: RulesDraft;
  locales: Readonly<Record<string, LocaleDraft>>;
  reason: string;
}

function emptyDraft(options: TypeNewOptions): Draft {
  const locales: Record<string, LocaleDraft> = {};
  for (const code of options.locales) locales[code] = { name: '', description: '', terms: '' };
  return {
    code: '',
    mode: '',
    rules: {
      requiresIssuerRegistry: false,
      requiresDocument: false,
      requiresExpiry: false,
      defaultBasis: options.defaultBases[0] ?? 'SELLER_REQUIRED',
      autoApprove: false,
      icon: options.badgeArtworkKeys.includes(TEXT_ARTWORK) ? TEXT_ARTWORK : '',
    },
    locales,
    reason: '',
  };
}

/** How many fields the admin has filled; the leave warning shows from 1. */
function filled(draft: Draft, empty: Draft): number {
  let count = 0;
  if (draft.code !== '') count += 1;
  if (draft.mode !== '') count += 1;
  if (JSON.stringify(draft.rules) !== JSON.stringify(empty.rules)) count += 1;
  for (const text of Object.values(draft.locales)) {
    if (text.name !== '' || text.description !== '' || text.terms !== '') count += 1;
  }
  if (draft.reason !== '') count += 1;
  return count;
}

export function TypeNewForm({
  options,
  csrfToken,
}: {
  readonly options: TypeNewOptions;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.types.fields');
  const tm = useTranslations('certificates.types.mode');
  const tr = useTranslations();
  const call = useTypeCall(csrfToken);
  const [empty] = useState(() => emptyDraft(options));
  const [draft, setDraft] = useState<Draft>(empty);
  const [shown, setShown] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The code was refused as taken or reserved: the text shows under the field.
  const [codeRefusal, setCodeRefusal] = useState<string | null>(null);
  const { limits } = options;

  const problems: Record<string, string> = {};
  const code = draft.code.trim();
  if (
    code.length < limits.codeMinLength ||
    code.length > limits.codeMaxLength ||
    !CODE_START.test(code) ||
    !CODE_CHARS.test(code)
  )
    problems.code = 'code';
  if (draft.mode === '') problems.mode = 'mode';
  if (!ICON_KEY.test(draft.rules.icon) || !options.badgeArtworkKeys.includes(draft.rules.icon))
    problems.icon = 'icon';
  if (draft.reason.trim().length > limits.reasonMaxLength) problems.reason = 'reason';
  let anyTerm = false;
  for (const [locale, text] of Object.entries(draft.locales)) {
    const name = text.name.trim();
    const description = text.description.trim();
    const terms = termsOf(text.terms);
    if (name === '' || name.length > limits.nameMaxLength) problems[`name-${locale}`] = 'name';
    if (description === '' || description.length > limits.descriptionMaxLength)
      problems[`description-${locale}`] = 'description';
    if (
      terms.length > limits.claimTermsPerLocale ||
      terms.some((term) => term.length > limits.claimTermMaxLength)
    )
      problems[`terms-${locale}`] = 'terms';
    if (terms.length > 0) anyTerm = true;
  }
  if (!anyTerm) problems.terms = 'terms-missing';

  const text = (kind: string) =>
    t(
      `problem.${kind}` as never,
      {
        nameMax: limits.nameMaxLength,
        descriptionMax: limits.descriptionMaxLength,
        termMax: limits.claimTermMaxLength,
        termsMax: limits.claimTermsPerLocale,
        reasonMax: limits.reasonMaxLength,
        codeMin: limits.codeMinLength,
        codeMax: limits.codeMaxLength,
      } as never,
    );
  const errors: Record<string, string | undefined> = {};
  if (shown) for (const [key, kind] of Object.entries(problems)) errors[key] = text(kind);
  const summary = Object.entries(errors).flatMap(([field, message]) =>
    message === undefined
      ? []
      : [
          {
            field:
              field === 'terms' ? Object.keys(draft.locales).map((l) => `terms-${l}`)[0]! : field,
            text: message,
          },
        ],
  );
  if (codeRefusal !== null) summary.unshift({ field: 'code', text: codeRefusal });

  const count = filled(draft, empty);
  const guard = useUnsavedChangesGuard(
    count > 0 && !leaving,
    {
      title: tr('settings.leave.title'),
      message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
      stay: tr('settings.leave.stay'),
      leave: tr('settings.leave.leave'),
    },
    { count, page: t('page') },
  );

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setRules = (patch: Partial<RulesDraft>) =>
    setDraft((current) => ({
      ...current,
      rules: normaliseRules(current.mode, { ...current.rules, ...patch }),
    }));
  const setLocale = (locale: string, patch: Partial<LocaleDraft>) =>
    setDraft((current) => ({
      ...current,
      locales: { ...current.locales, [locale]: { ...current.locales[locale]!, ...patch } },
    }));
  const chooseMode = (mode: string) =>
    setDraft((current) => ({ ...current, mode, rules: normaliseRules(mode, current.rules) }));

  function review(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    if (Object.keys(problems).length > 0) {
      setFocusKey((key) => key + 1);
      return;
    }
    setReviewing(true);
  }

  const rules = normaliseRules(draft.mode, draft.rules);
  const content = {
    verificationMode: draft.mode,
    requiresIssuerRegistry: rules.requiresIssuerRegistry,
    requiresDocument: rules.requiresDocument,
    requiresExpiry: rules.requiresExpiry,
    defaultBasis: rules.defaultBasis,
    autoApproveSelfDeclaration: draft.mode === 'SELF_DECLARATION' ? rules.autoApprove : false,
    badgeIconKey: rules.icon,
    locales: Object.fromEntries(
      Object.entries(draft.locales).map(([locale, value]) => [
        locale,
        {
          name: value.name.trim(),
          customerDescription: value.description.trim(),
          claimTerms: termsOf(value.terms),
        },
      ]),
    ),
  };
  const termsByLocale = Object.fromEntries(
    Object.entries(draft.locales).map(([locale, value]) => [locale, termsOf(value.terms)]),
  );
  const why = draft.reason.trim();
  const view: NewTypeSummary = {
    code,
    mode: draft.mode,
    rules,
    termsByLocale,
  };

  async function send() {
    const answer = await call.run<TypeCreated>(API_TYPES, {
      code,
      content,
      ...(why === '' ? {} : { reason: why }),
    });
    if (answer.ok) {
      flushSync(() => setLeaving(true));
      window.location.assign(`/certificates/types/${answer.body.typeId}?done=proposed`);
      return;
    }
    if (answer.problem?.codeField === true) {
      // The dialog closes; the refusal shows under Code and focus goes there.
      setCodeRefusal(tr(answer.problem.key));
      setReviewing(false);
      setShown(true);
      setTimeout(() => document.querySelector<HTMLElement>('[data-field="code"]')?.focus(), 0);
    }
  }

  const codeError = errors.code ?? codeRefusal ?? undefined;
  return (
    <form onSubmit={review} className="flex flex-col gap-6 pb-20 min-[760px]:pb-0" noValidate>
      <ErrorSummary items={summary} focusKey={focusKey} />
      <fieldset className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
        <legend className="px-1 text-base font-semibold">{t('basics')}</legend>
        <TextField
          label={t('code')}
          value={draft.code}
          onChange={(event) => {
            setCodeRefusal(null);
            set({ code: event.target.value });
          }}
          placeholder={t('code-placeholder')}
          help={t('code-help', { min: limits.codeMinLength, max: limits.codeMaxLength })}
          error={codeError}
          maxLength={64}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          data-field="code"
        />
        <RadioGroup
          legend={t('mode')}
          name="verification-mode"
          value={draft.mode}
          onChange={chooseMode}
          options={options.verificationModes.map((value) => ({
            value,
            label: tm.has(value as never) ? tm(value as never) : value,
            help: t(`mode-help.${value}` as never),
          }))}
          note={
            errors.mode === undefined ? (
              t('mode-note')
            ) : (
              <>
                <span className="block text-critical-fg">{errors.mode}</span>
                {t('mode-note')}
              </>
            )
          }
        />
      </fieldset>
      <RulesFields
        variant="new"
        mode={draft.mode}
        value={rules}
        onChange={setRules}
        artworkKeys={options.badgeArtworkKeys}
        bases={options.defaultBases}
        errors={{ icon: errors.icon }}
      />
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">{t('wording-intro')}</p>
        <WordingFields
          variant="new"
          locales={draft.locales}
          onChange={setLocale}
          errors={errors}
          limits={{ name: limits.nameMaxLength, description: limits.descriptionMaxLength }}
        />
      </div>
      <TextAreaField
        label={t('reason')}
        optionalLabel={t('optional')}
        rows={3}
        value={draft.reason}
        onChange={(event) => set({ reason: event.target.value })}
        help={t('reason-help', { max: limits.reasonMaxLength })}
        error={errors.reason}
        dir="auto"
        data-field="reason"
      />
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-surface px-4 py-3 min-[760px]:static min-[760px]:mx-0 min-[760px]:flex-row min-[760px]:justify-end min-[760px]:border-0 min-[760px]:bg-transparent min-[760px]:p-0">
        <LinkButton variant="secondary" href="/certificates/types">
          {t('cancel')}
        </LinkButton>
        <Button type="submit">{t('review')}</Button>
      </div>
      {guard.dialog}
      {reviewing ? (
        <TypeReviewDialog
          summary={view}
          csrfToken={csrfToken}
          pending={call.pending}
          problem={call.problem?.codeField === true ? null : call.problem}
          onBack={() => setReviewing(false)}
          onSend={() => void send()}
        />
      ) : null}
    </form>
  );
}
