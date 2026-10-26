'use client';

import { ActionRow, Banner, Button, Card, CheckboxRow, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  checkForm,
  moved,
  sharePercent,
  unchosen,
  weightFaults,
  weightTotal,
  WEIGHT_KEYS,
  type FormField,
  type ModelForm,
  type WeightKey,
} from './form.ts';
import { KINDS, type FleetCode, type FleetRow, type Kind, type Rule } from './types.ts';

const P = 'fleets';

type Arrow = 'up' | 'down';

/**
 * The form of one model: a name, a kind, and the settings of that kind (weights or an ordered
 * fleet list). It checks the shape, then hands the body up; the API checks all of it again.
 * It scrolls into view and takes focus when it opens; a refused submit focuses the first
 * invalid field.
 */
export function ModelFormCard({
  title,
  initial,
  fleets,
  pending,
  problem,
  activeNote,
  onSubmit,
  onCancel,
}: {
  readonly title: string;
  readonly initial: ModelForm;
  readonly fleets: readonly FleetRow[];
  readonly pending: boolean;
  /** The message key under `fleets.error` of the last refused save, or null. */
  readonly problem: string | null;
  /** Names the methods this model is active for (an edit goes live at once), or null. */
  readonly activeNote: string | null;
  readonly onSubmit: (body: { name: string; rule: Rule }) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations();
  const [form, setForm] = useState(initial);
  const [invalid, setInvalid] = useState<readonly FormField[]>([]);
  const [announce, setAnnounce] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pendingFocus = useRef<{ fleet: FleetCode; arrow: Arrow } | null>(null);
  const ids = useId();
  const weightsErrorId = `${ids}-weights-error`;
  const orderErrorId = `${ids}-order-error`;
  const nameOf = (fleet: FleetCode) =>
    fleets.find((row) => row.fleet === fleet)?.displayName ?? fleet;
  const listed = fleets.map((row) => row.fleet);
  const field = (name: string) =>
    formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`) ?? null;

  // On open: bring the form into view and put the cursor in the name.
  useEffect(() => {
    root.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    field('name')?.focus({ preventScroll: true });
  }, []);

  // After a move: keep focus on the pressed arrow, or on the other one when it became disabled.
  useEffect(() => {
    const next = pendingFocus.current;
    if (next === null) return;
    pendingFocus.current = null;
    const pressed = field(`${next.arrow}-${next.fleet}`);
    const other = field(`${next.arrow === 'up' ? 'down' : 'up'}-${next.fleet}`);
    const usable = (el: HTMLElement | null) => el !== null && !(el as HTMLButtonElement).disabled;
    (usable(pressed) ? pressed : usable(other) ? other : null)?.focus();
  }, [form.order]);

  const faults = invalid.includes('weights') ? weightFaults(form.weights) : {};
  const total = weightTotal(form.weights);

  function submit(event: FormEvent) {
    event.preventDefault();
    const checked = checkForm(form);
    if (!checked.ok) {
      setInvalid(checked.invalid);
      const first = checked.invalid[0];
      const target =
        first === 'name'
          ? field('name')
          : first === 'weights'
            ? field(
                `weight-${WEIGHT_KEYS.find((key) => weightFaults(form.weights)[key]) ?? 'price'}`,
              )
            : (formRef.current?.querySelector<HTMLElement>('input[name^="add-"]') ?? field('kind'));
      target?.focus();
      return;
    }
    setInvalid([]);
    onSubmit({ name: checked.name, rule: checked.rule });
  }

  function move(fleet: FleetCode, index: number, by: -1 | 1) {
    const order = moved(form.order, index, by);
    pendingFocus.current = { fleet, arrow: by === -1 ? 'up' : 'down' };
    setForm((current) => ({ ...current, order }));
    setAnnounce(t(`${P}.order.moved`, { fleet: nameOf(fleet), position: index + by + 1 }));
  }

  const weight = (key: WeightKey) => {
    const fault = faults[key];
    const value = form.weights[key].trim();
    const number = /^\d{1,3}$/.test(value) ? Number(value) : 0;
    return (
      <TextField
        key={key}
        name={`weight-${key}`}
        label={t(`${P}.weight.${key}`)}
        help={t(`${P}.weight.share`, {
          value: number,
          total,
          percent: sharePercent(number, total),
        })}
        error={fault === undefined ? undefined : t(`${P}.invalid.weight-${fault}`)}
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
  };

  const orderInvalid = invalid.includes('order');

  return (
    <div ref={root} tabIndex={-1} className="scroll-mt-4 outline-none">
      <Card title={title}>
        <form ref={formRef} className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {activeNote === null ? null : (
            <Banner tone="attention">
              {t(`${P}.models.active-note`, { methods: activeNote })}
            </Banner>
          )}
          <TextField
            name="name"
            label={t(`${P}.model.name`)}
            help={t(`${P}.model.name-help`)}
            autoComplete="off"
            value={form.name}
            error={invalid.includes('name') ? t(`${P}.invalid.name`) : undefined}
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
            <fieldset
              className="flex flex-col gap-3"
              aria-describedby={invalid.includes('weights') ? weightsErrorId : undefined}
            >
              <legend className="text-sm font-medium text-fg">{t(`${P}.weight.title`)}</legend>
              <p className="text-sm text-fg-muted">{t(`${P}.weight.help`)}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {weight('price')}
                {weight('eta')}
                {weight('reliability')}
              </div>
              <p className="text-sm text-fg-muted">{t(`${P}.weight.total`, { total })}</p>
              {invalid.includes('weights') ? (
                <p id={weightsErrorId} role="alert" className="text-sm text-critical-fg">
                  {t(`${P}.invalid.weights`)}
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {form.kind === 'fixed_priority' ? (
            <fieldset
              className="flex flex-col gap-3"
              aria-describedby={orderInvalid ? orderErrorId : undefined}
            >
              <legend className="text-sm font-medium text-fg">{t(`${P}.order.title`)}</legend>
              <p className="text-sm text-fg-muted">{t(`${P}.order.help`)}</p>
              <p role="status" aria-live="polite" className="sr-only">
                {announce}
              </p>
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
                        name={`up-${fleet}`}
                        variant="secondary"
                        aria-label={t(`${P}.order.up`, { fleet: nameOf(fleet) })}
                        disabled={index === 0}
                        onClick={() => move(fleet, index, -1)}
                      >
                        {t(`${P}.order.up-short`)}
                      </Button>
                      <Button
                        name={`down-${fleet}`}
                        variant="secondary"
                        aria-label={t(`${P}.order.down`, { fleet: nameOf(fleet) })}
                        disabled={index === form.order.length - 1}
                        onClick={() => move(fleet, index, 1)}
                      >
                        {t(`${P}.order.down-short`)}
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={t(`${P}.order.remove`, { fleet: nameOf(fleet) })}
                        onClick={() => {
                          setForm((current) => ({
                            ...current,
                            order: current.order.filter((code) => code !== fleet),
                          }));
                          setAnnounce(t(`${P}.order.removed`, { fleet: nameOf(fleet) }));
                        }}
                      >
                        {t(`${P}.order.remove-short`)}
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
              <div
                role="group"
                aria-label={t(`${P}.order.add-group`)}
                aria-describedby={orderInvalid ? orderErrorId : undefined}
                className="flex flex-col gap-2"
              >
                {unchosen(form.order, listed).map((fleet) => {
                  const off = fleets.find((row) => row.fleet === fleet)?.enabled === false;
                  return (
                    <CheckboxRow
                      key={fleet}
                      name={`add-${fleet}`}
                      label={t(`${P}.order.${off ? 'add-off' : 'add'}`, { fleet: nameOf(fleet) })}
                      aria-invalid={orderInvalid ? true : undefined}
                      checked={false}
                      onChange={() =>
                        setForm((current) => ({ ...current, order: [...current.order, fleet] }))
                      }
                    />
                  );
                })}
              </div>
              {orderInvalid ? (
                <p id={orderErrorId} role="alert" className="text-sm text-critical-fg">
                  {t(`${P}.invalid.order`)}
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
    </div>
  );
}
