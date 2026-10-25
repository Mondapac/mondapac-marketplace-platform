'use client';

import { ActionRow, Button, Card, CheckboxRow, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { checkForm, moved, unchosen, type FormField, type ModelForm } from './form.ts';
import { KINDS, type FleetCode, type FleetRow, type Kind, type Rule } from './types.ts';

const P = 'fleets';

/**
 * The form of one model: a name, a kind, and the settings of that kind (weights or an ordered
 * fleet list). It checks the shape, then hands the body up; the API checks all of it again.
 */
export function ModelFormCard({
  title,
  initial,
  fleets,
  pending,
  problem,
  onSubmit,
  onCancel,
}: {
  readonly title: string;
  readonly initial: ModelForm;
  readonly fleets: readonly FleetRow[];
  readonly pending: boolean;
  /** The message key under `fleets.error` of the last refused save, or null. */
  readonly problem: string | null;
  readonly onSubmit: (body: { name: string; rule: Rule }) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations();
  const [form, setForm] = useState(initial);
  const [invalid, setInvalid] = useState<readonly FormField[]>([]);
  const nameOf = (fleet: FleetCode) =>
    fleets.find((row) => row.fleet === fleet)?.displayName ?? fleet;
  const errorOf = (field: FormField) =>
    invalid.includes(field) ? t(`${P}.invalid.${field}`) : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    const checked = checkForm(form);
    if (!checked.ok) {
      setInvalid(checked.invalid);
      return;
    }
    setInvalid([]);
    onSubmit({ name: checked.name, rule: checked.rule });
  }

  const weight = (key: 'price' | 'eta' | 'reliability') => (
    <TextField
      key={key}
      name={`weight-${key}`}
      label={t(`${P}.weight.${key}`)}
      inputMode="numeric"
      autoComplete="off"
      value={form.weights[key]}
      onChange={(event) =>
        setForm((current) => ({
          ...current,
          weights: { ...current.weights, [key]: event.target.value },
        }))
      }
    />
  );

  return (
    <Card title={title}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          name="name"
          label={t(`${P}.model.name`)}
          help={t(`${P}.model.name-help`)}
          autoComplete="off"
          value={form.name}
          error={errorOf('name')}
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        />
        <Select
          name="kind"
          label={t(`${P}.model.kind`)}
          help={t(`${P}.kind-help.${form.kind}`)}
          options={KINDS.map((kind) => ({ value: kind, label: t(`${P}.kind.${kind}`) }))}
          value={form.kind}
          onChange={(event) =>
            setForm((current) => ({ ...current, kind: event.target.value as Kind }))
          }
        />
        {form.kind === 'weighted' ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-fg">{t(`${P}.weight.title`)}</legend>
            <p className="text-sm text-fg-muted">{t(`${P}.weight.help`)}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {weight('price')}
              {weight('eta')}
              {weight('reliability')}
            </div>
            {errorOf('weights') ? (
              <p role="alert" className="text-sm text-critical-fg">
                {errorOf('weights')}
              </p>
            ) : null}
          </fieldset>
        ) : null}
        {form.kind === 'fixed_priority' ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-fg">{t(`${P}.order.title`)}</legend>
            <p className="text-sm text-fg-muted">{t(`${P}.order.help`)}</p>
            <ol className="flex flex-col gap-2">
              {form.order.map((fleet, index) => (
                <li
                  key={fleet}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-sm">
                    {index + 1}. {nameOf(fleet)}
                  </span>
                  <span className="flex gap-2">
                    <Button
                      variant="secondary"
                      aria-label={t(`${P}.order.up`, { fleet: nameOf(fleet) })}
                      disabled={index === 0}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          order: moved(current.order, index, -1),
                        }))
                      }
                    >
                      {t(`${P}.order.up-short`)}
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={t(`${P}.order.down`, { fleet: nameOf(fleet) })}
                      disabled={index === form.order.length - 1}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          order: moved(current.order, index, 1),
                        }))
                      }
                    >
                      {t(`${P}.order.down-short`)}
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={t(`${P}.order.remove`, { fleet: nameOf(fleet) })}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          order: current.order.filter((code) => code !== fleet),
                        }))
                      }
                    >
                      {t(`${P}.order.remove-short`)}
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
            {unchosen(
              form.order,
              fleets.map((row) => row.fleet),
            ).map((fleet) => (
              <CheckboxRow
                key={fleet}
                name={`add-${fleet}`}
                label={t(`${P}.order.add`, { fleet: nameOf(fleet) })}
                checked={false}
                onChange={() =>
                  setForm((current) => ({ ...current, order: [...current.order, fleet] }))
                }
              />
            ))}
            {errorOf('order') ? (
              <p role="alert" className="text-sm text-critical-fg">
                {errorOf('order')}
              </p>
            ) : null}
          </fieldset>
        ) : null}
        {problem === null ? null : (
          <p role="alert" className="text-sm text-critical-fg">
            {t(`${P}.error.${problem}`)}
          </p>
        )}
        <ActionRow>
          <Button type="submit" loading={pending}>
            {t(`${P}.model.save`)}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t(`${P}.model.cancel`)}
          </Button>
        </ActionRow>
      </form>
    </Card>
  );
}
