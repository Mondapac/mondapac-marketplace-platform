'use client';

import { Badge, Banner, Button, Card, EmptyState, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { fleetProblemOf } from './errors.ts';
import { FleetsCard } from './fleets-card.tsx';
import { EMPTY_FORM, formOf } from './form.ts';
import { ModelFormCard } from './model-form.tsx';
import {
  FLEET_SELECTION_PATH,
  METHODS,
  type FleetCode,
  type Method,
  type Model,
  type Rule,
  type Selection,
} from './types.ts';

const P = 'fleets';
const DEFAULT_OPTION = '';

type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly model: Model } | null;

export function FleetSelectionPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: Selection;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const [selection, setSelection] = useState(initial);
  const [choice, setChoice] = useState<Record<Method, string>>(() => choiceOf(initial));
  const [editing, setEditing] = useState<Editing>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<'activated' | 'created' | 'edited' | 'reloaded' | null>(
    null,
  );
  const [pending, setPending] = useState<'active' | 'model' | null>(null);
  const busy = useRef(false);

  const nameOf = (fleet: FleetCode) =>
    selection.fleets.find((row) => row.fleet === fleet)?.displayName ?? fleet;

  function adopt(next: Selection) {
    setSelection(next);
    setChoice(choiceOf(next));
  }

  const ended = (status: number) => {
    if (status === 401) window.location.assign('/session-ended');
    return status === 401;
  };

  async function saveActive(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending('active');
    setNotice(null);
    setProblem(null);
    let latest: Selection | null = null;
    for (const method of METHODS) {
      const wanted = choice[method] === DEFAULT_OPTION ? null : choice[method];
      if (wanted === selection.active[method]) continue;
      const result = await callApi<Selection>(
        'PUT',
        `${FLEET_SELECTION_PATH}/active/${method}`,
        { modelId: wanted },
        csrfToken,
      );
      if (!result.ok) {
        if (!ended(result.failure.status)) setProblem(fleetProblemOf(result.failure));
        break;
      }
      latest = result.body;
    }
    if (latest !== null) {
      adopt(latest);
      setNotice('activated');
    }
    busy.current = false;
    setPending(null);
  }

  async function saveModel(body: { name: string; rule: Rule }) {
    if (busy.current || editing === null) return;
    busy.current = true;
    setPending('model');
    setFormProblem(null);
    const creating = editing.kind === 'new';
    const result = creating
      ? await callApi<Model>('POST', `${FLEET_SELECTION_PATH}/models`, body, csrfToken)
      : await callApi<Model>(
          'PUT',
          `${FLEET_SELECTION_PATH}/models/${editing.model.id}`,
          { ...body, expectedVersion: editing.model.version },
          csrfToken,
        );
    if (result.ok) {
      const fresh = await callApi<Selection>('GET', FLEET_SELECTION_PATH);
      if (fresh.ok) adopt(fresh.body);
      setEditing(null);
      setNotice(creating ? 'created' : 'edited');
    } else if (!ended(result.failure.status)) {
      const key = fleetProblemOf(result.failure);
      setFormProblem(key);
      if (key === 'conflict') {
        // Someone saved first: show what is stored now, so the admin decides again on that.
        const fresh = await callApi<Selection>('GET', FLEET_SELECTION_PATH);
        if (fresh.ok) {
          adopt(fresh.body);
          setEditing(null);
          setNotice('reloaded');
          setFormProblem(null);
        }
      }
    }
    busy.current = false;
    setPending(null);
  }

  const options = [
    { value: DEFAULT_OPTION, label: t(`${P}.active.default`) },
    ...selection.models.map((model) => ({ value: model.id, label: model.name })),
  ];

  return (
    <div className="flex flex-col gap-6">
      {notice === null ? null : <Banner tone="success">{t(`${P}.notice.${notice}`)}</Banner>}

      <Card title={t(`${P}.active.title`)}>
        <p className="text-sm text-fg-muted">
          {t(`${P}.active.intro`, {
            order: selection.defaultOrder.map(nameOf).join(', '),
          })}
        </p>
        {problem === null ? null : <Banner tone="critical">{t(`${P}.error.${problem}`)}</Banner>}
        {canManage ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => void saveActive(e)} noValidate>
            <div className="grid gap-4 md:grid-cols-3">
              {METHODS.map((method) => (
                <Select
                  key={method}
                  name={`active-${method}`}
                  label={t(`${P}.method.${method}`)}
                  options={options}
                  value={choice[method]}
                  onChange={(event) =>
                    setChoice((current) => ({ ...current, [method]: event.target.value }))
                  }
                />
              ))}
            </div>
            <div>
              <Button type="submit" loading={pending === 'active'}>
                {t(`${P}.active.save`)}
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-3 md:grid-cols-3">
            {METHODS.map((method) => (
              <div key={method}>
                <dt className="text-sm text-fg-muted">{t(`${P}.method.${method}`)}</dt>
                <dd className="font-medium">
                  {selection.models.find((model) => model.id === selection.active[method])?.name ??
                    t(`${P}.active.default`)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card title={t(`${P}.models.title`)}>
        <p className="text-sm text-fg-muted">{t(`${P}.models.intro`)}</p>
        {selection.models.length === 0 ? (
          <EmptyState icon="package" size="compact" title={t(`${P}.models.empty`)} />
        ) : (
          <ul className="flex flex-col gap-3">
            {selection.models.map((model) => {
              const activeFor = METHODS.filter((method) => selection.active[method] === model.id);
              return (
                <li
                  key={model.id}
                  className="flex flex-col gap-2 rounded-md border border-line p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-medium">{model.name}</h3>
                    <Badge tone="info">{t(`${P}.kind.${model.rule.kind}`)}</Badge>
                  </div>
                  <p className="text-sm text-fg-muted">{summaryOf(model.rule, nameOf, t)}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">
                      {activeFor.length === 0
                        ? t(`${P}.models.unused`)
                        : t(`${P}.models.used`, {
                            methods: activeFor
                              .map((method) => t(`${P}.method.${method}`))
                              .join(', '),
                          })}
                    </p>
                    {canManage ? (
                      <Button
                        variant="secondary"
                        aria-label={t(`${P}.models.edit-named`, { name: model.name })}
                        onClick={() => {
                          setFormProblem(null);
                          setEditing({ kind: 'edit', model });
                        }}
                      >
                        {t(`${P}.models.edit`)}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {canManage && editing === null ? (
          <div>
            <Button
              onClick={() => {
                setFormProblem(null);
                setNotice(null);
                setEditing({ kind: 'new' });
              }}
            >
              {t(`${P}.models.new`)}
            </Button>
          </div>
        ) : null}
      </Card>

      {editing === null ? null : (
        <ModelFormCard
          key={editing.kind === 'new' ? 'new' : `${editing.model.id}-${editing.model.version}`}
          title={editing.kind === 'new' ? t(`${P}.models.new`) : t(`${P}.models.editing`)}
          initial={editing.kind === 'new' ? EMPTY_FORM : formOf(editing.model)}
          fleets={selection.fleets}
          pending={pending === 'model'}
          problem={formProblem}
          onSubmit={(body) => void saveModel(body)}
          onCancel={() => setEditing(null)}
        />
      )}

      <FleetsCard
        fleets={selection.fleets}
        canManage={canManage}
        csrfToken={csrfToken}
        onSelection={adopt}
      />
    </div>
  );
}

function choiceOf(selection: Selection): Record<Method, string> {
  return {
    instant: selection.active.instant ?? DEFAULT_OPTION,
    same_day: selection.active.same_day ?? DEFAULT_OPTION,
    scheduled: selection.active.scheduled ?? DEFAULT_OPTION,
  };
}

function summaryOf(
  rule: Rule,
  nameOf: (fleet: FleetCode) => string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (rule.kind === 'cheapest') return t(`${P}.summary.cheapest`);
  if (rule.kind === 'weighted') {
    return t(`${P}.summary.weighted`, {
      price: rule.weights?.price ?? 0,
      eta: rule.weights?.eta ?? 0,
      reliability: rule.weights?.reliability ?? 0,
    });
  }
  return t(`${P}.summary.fixed_priority`, {
    order: (rule.order ?? []).map((fleet, index) => `${index + 1}. ${nameOf(fleet)}`).join('  '),
  });
}
