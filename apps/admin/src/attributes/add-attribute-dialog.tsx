'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  RadioGroup,
  TextAreaField,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFocusFirstInvalid } from '../auth/use-focus-first-invalid.ts';
import { MeasureSettings } from './measure-settings.tsx';
import {
  CODE_PATTERN,
  NAME_MAX,
  OPTIONS_MAX,
  checkForm,
  contentOf,
  emptyForm,
  fieldKey,
  measureDefaults,
  sentCodes,
  suggestCode,
  valuesFromLines,
  type FieldErrors,
} from './editor.ts';
import {
  API_ATTRIBUTES,
  CHOICE_TYPES,
  DATA_TYPES,
  directionOf,
  languageName,
  type AttributeWrite,
  type DataType,
  type MarketLocales,
  type MarketUnit,
} from './types.ts';
import { useAttributeCall } from './use-attribute-call.ts';

/**
 * Add an attribute (attributes A2): step 1 picks the type, each with an example; step 2 names it
 * in the Market's default language and, for a choice type, lists its first values. The attribute
 * is saved as a draft that sellers do not see; other languages, help text and settings are filled
 * in the editor before it is published.
 */
export function AddAttributeDialog({
  locales,
  units,
  csrfToken,
  onClose,
  onCreated,
}: {
  readonly locales: MarketLocales;
  /** The Market's units, for a number-with-unit attribute. */
  readonly units: readonly MarketUnit[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const t = useTranslations('attributes.add');
  const te = useTranslations('attributes.editor');
  const tt = useTranslations('attributes.type');
  const [step, setStep] = useState<1 | 2>(1);
  const [dataType, setDataType] = useState<DataType>('select');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [values, setValues] = useState('');
  const [variant, setVariant] = useState(false);
  const [material, setMaterial] = useState(false);
  const [measureForm, setMeasureForm] = useState(() => ({
    ...emptyForm(),
    ...measureDefaults(units, 'mass'),
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const call = useAttributeCall(csrfToken);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, errors);
  // Step 2 opens on the name.
  useEffect(() => {
    if (step === 2) formRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
  }, [step]);
  const locale = locales.default;
  const language = languageName(locale, locales.supported);
  const choice = CHOICE_TYPES.has(dataType);
  const suggested = suggestCode(name);
  const msg = (path: string) => {
    const reason = errors[path];
    return reason === undefined ? undefined : te(`field.${fieldKey(reason)}`);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const rows = choice ? valuesFromLines(values, locale) : [];
    const form = {
      ...measureForm,
      names: { [locale]: name },
      values: rows,
      isVariantOption: variant,
      material,
    };
    const found: Record<string, string> = { ...checkForm(form, dataType, locale) };
    const typed = code.trim();
    if (typed !== '' && !CODE_PATTERN.test(typed)) found['code'] = 'format';
    if (typed === '' && suggested === '') found['code'] = 'required';
    if (rows.length > OPTIONS_MAX) found['options'] = 'too-many';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const answer = await call.run<AttributeWrite>(
      'POST',
      API_ATTRIBUTES,
      {
        dataType,
        ...(typed === '' ? {} : { code: typed }),
        ...contentOf(form, dataType, locale),
      },
      sentCodes(rows, locale),
    );
    if (!answer.ok) {
      if (answer.problem !== null) setErrors(answer.problem.fields);
      return;
    }
    onCreated(answer.body.attribute.id);
  }

  const formId = 'add-attribute-form';
  // A value's refusal names its line in the box (values are the non-blank lines, in order).
  const valueErrors = Object.entries(errors)
    .filter(([path]) => path.startsWith('options'))
    .map(([path, reason]) => {
      const line = /^options\[(\d+)\]/.exec(path)?.[1];
      const text = te(`field.${fieldKey(reason)}`);
      return line === undefined ? text : t('line', { number: Number(line) + 1, message: text });
    });

  return (
    <Dialog
      open
      title={`${t('title')} · ${t(step === 1 ? 'step-1' : 'step-2')}`}
      onClose={onClose}
      actions={
        step === 1 ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('cancel')}
            </Button>
            {/* Its own key: reusing this element as the submit button would submit the form. */}
            <Button key="next" onClick={() => setStep(2)}>
              {t('next')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={call.pending} onClick={() => setStep(1)}>
              {t('back')}
            </Button>
            <Button
              key="create"
              type="submit"
              form={formId}
              loading={call.pending}
              disabled={call.pending}
            >
              {t('create')}
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <RadioGroup
          legend={t('type-legend')}
          name="attribute-type"
          value={dataType}
          options={DATA_TYPES.map((type) => ({
            value: type,
            label: tt(type),
            help: t(`example.${type}`),
          }))}
          onChange={(value) => setDataType(value as DataType)}
        />
      ) : (
        <form
          ref={formRef}
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <p className="text-sm text-fg-muted">
            {t('type-chosen', { type: tt(dataType) })} {t('draft-note')}
          </p>
          {call.problem === null ? null : (
            <Banner tone="critical">{te(`error.${call.problem.key}`)}</Banner>
          )}
          <TextField
            name="name"
            label={t('name', { language })}
            value={name}
            maxLength={NAME_MAX}
            lang={locale}
            dir={directionOf(locale)}
            error={msg(`names.${locale}`)}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            name="code"
            label={t('code')}
            help={t('code-help')}
            optionalLabel={t('optional')}
            value={code}
            placeholder={suggested}
            maxLength={64}
            error={msg('code')}
            autoComplete="off"
            onChange={(event) => setCode(event.target.value)}
          />
          {choice ? (
            <TextAreaField
              name="values"
              label={t('values', { language })}
              help={t('values-help')}
              optionalLabel={t('optional')}
              rows={5}
              value={values}
              lang={locale}
              dir={directionOf(locale)}
              error={valueErrors.length === 0 ? undefined : valueErrors.join(' ')}
              onChange={(event) => setValues(event.target.value)}
            />
          ) : null}
          {dataType === 'measure' ? (
            <MeasureSettings
              form={measureForm}
              units={units}
              defaultLocale={locale}
              savedUnits={[]}
              locked={false}
              errors={errors}
              onChange={(next) => setMeasureForm((current) => ({ ...current, ...next }))}
            />
          ) : null}
          {dataType === 'select' ? (
            <CheckboxRow
              label={te('settings.variant')}
              help={te('settings.variant-help')}
              checked={variant}
              onChange={(event) => setVariant(event.target.checked)}
            />
          ) : null}
          <CheckboxRow
            label={te('settings.material')}
            help={te('settings.material-help')}
            checked={material}
            onChange={(event) => setMaterial(event.target.checked)}
          />
        </form>
      )}
    </Dialog>
  );
}
