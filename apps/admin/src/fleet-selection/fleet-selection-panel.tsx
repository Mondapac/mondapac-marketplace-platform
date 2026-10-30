'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  SaveBar,
  SettingRow,
  SettingSelect,
  SettingsConflictBanner,
  SettingsPage,
  SettingsSection,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
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

type Confirm =
  | { readonly kind: 'active' }
  | { readonly kind: 'edit'; readonly body: { name: string; rule: Rule } }
  | null;

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
  const chrome = useSettingsChrome();
  const [selection, setSelection] = useState(initial);
  const [choice, setChoice] = useState<Record<Method, string>>(() => choiceOf(initial));
  const [editing, setEditing] = useState<Editing>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<'reloaded' | null>(null);
  const [pending, setPending] = useState<'active' | 'model' | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const busy = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Where focus goes after a saved model: its row heading, or "New model" after a create. The
  // form and its buttons are gone by then, and the toast never takes focus.
  const focusNext = useRef<{ kind: 'add' } | { kind: 'model'; id: string } | null>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (target.kind === 'add' ? addButton.current : headings.current.get(target.id))?.focus();
  });

  // A reloaded page moves focus to its note, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

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

  /** The methods whose model the admin changed, with the names before and after. */
  const changes = METHODS.flatMap((method) => {
    const wanted = choice[method] === DEFAULT_OPTION ? null : choice[method];
    if (wanted === selection.active[method]) return [];
    const label = (id: string | null) =>
      selection.models.find((model) => model.id === id)?.name ?? t(`${P}.active.default`);
    return [{ method, from: label(selection.active[method]), to: label(wanted) }];
  });
  const changedMethod = (method: Method) => changes.some((change) => change.method === method);

  function askActive(event: FormEvent) {
    event.preventDefault();
    if (changes.length > 0) setConfirm({ kind: 'active' });
  }

  function discard() {
    setChoice(choiceOf(selection));
    setProblem(null);
  }

  async function saveActive() {
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
      toast.success(t(`${P}.notice.activated`));
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
      focusNext.current = creating ? { kind: 'add' } : { kind: 'model', id: editing.model.id };
      toast.success(t(`${P}.notice.${creating ? 'created' : 'edited'}`));
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
    ...selection.models.map((model) => ({
      value: model.id,
      label: t(`${P}.model.option`, { name: model.name, kind: t(`${P}.kind.${model.rule.kind}`) }),
    })),
  ];
  const methodsOf = (model: Model) =>
    METHODS.filter((method) => selection.active[method] === model.id);

  const banners = [
    canManage ? null : (
      <Banner key="viewer-only" tone="info">
        {t(`${P}.viewer-only`)}
      </Banner>
    ),
    notice === null ? null : (
      <div key="conflict" ref={noticeRef} tabIndex={-1} className="outline-none">
        <SettingsConflictBanner
          title={t(`${P}.conflict.title`)}
          body={t(`${P}.notice.${notice}`)}
        />
      </div>
    ),
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`${P}.error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t(`${P}.title`)}
      description={t(`${P}.intro`)}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      dirty={canManage && (changes.length > 0 || editing !== null)}
      leave={chrome.leave}
    >
      {/* The one form of the page with a save bar; each model and each fleet score has its own. */}
      <form className="flex flex-col gap-4" onSubmit={askActive} noValidate>
        <SettingsSection
          title={t(`${P}.active.title`)}
          description={t(`${P}.active.intro`, {
            order: selection.defaultOrder.map(nameOf).join(', '),
          })}
        >
          {METHODS.map((method) => (
            <SettingRow
              key={method}
              label={t(`${P}.method.${method}`)}
              changed={changedMethod(method)}
              disabled={!canManage}
            >
              <SettingSelect
                name={`active-${method}`}
                options={options}
                value={choice[method]}
                onChange={(event) =>
                  setChoice((current) => ({ ...current, [method]: event.target.value }))
                }
              />
            </SettingRow>
          ))}
        </SettingsSection>
        {canManage ? (
          <SaveBar
            {...chrome.saveBar({
              count: changes.length,
              saving: pending === 'active',
              onDiscard: discard,
            })}
          />
        ) : null}
      </form>

      <SettingsSection title={t(`${P}.models.title`)} description={t(`${P}.models.intro`)}>
        {selection.models.length === 0 ? (
          <div className="px-5 py-4">
            <EmptyState icon="package" size="compact" title={t(`${P}.models.empty`)} />
          </div>
        ) : (
          <ul className="flex flex-col">
            {selection.models.map((model) => {
              const activeFor = methodsOf(model);
              return (
                <li
                  key={model.id}
                  className="flex flex-col gap-2 border-b border-line-row px-5 py-4 last:border-b-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3
                      ref={(element) => {
                        if (element === null) headings.current.delete(model.id);
                        else headings.current.set(model.id, element);
                      }}
                      tabIndex={-1}
                      className="text-base font-medium outline-none"
                    >
                      {model.name}
                    </h3>
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
          <div className="border-t border-line-row px-5 py-4 first:border-t-0">
            <Button
              ref={addButton}
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
      </SettingsSection>

      {editing === null ? null : (
        <ModelFormCard
          key={editing.kind === 'new' ? 'new' : `${editing.model.id}-${editing.model.version}`}
          title={editing.kind === 'new' ? t(`${P}.models.new`) : t(`${P}.models.editing`)}
          initial={editing.kind === 'new' ? EMPTY_FORM : formOf(editing.model)}
          fleets={selection.fleets}
          pending={pending === 'model'}
          problem={formProblem}
          activeNote={
            editing.kind === 'edit' && methodsOf(editing.model).length > 0
              ? methodsOf(editing.model)
                  .map((method) => t(`${P}.method.${method}`))
                  .join(', ')
              : null
          }
          onSubmit={(body) => {
            if (editing.kind === 'edit' && methodsOf(editing.model).length > 0) {
              setConfirm({ kind: 'edit', body });
            } else void saveModel(body);
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <Dialog
        open={confirm !== null}
        title={t(`${P}.confirm.${confirm?.kind === 'edit' ? 'edit-title' : 'title'}`)}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t(`${P}.confirm.cancel`)}
            </Button>
            <Button
              onClick={() => {
                const taken = confirm;
                setConfirm(null);
                if (taken?.kind === 'active') void saveActive();
                else if (taken?.kind === 'edit') void saveModel(taken.body);
              }}
            >
              {t(`${P}.confirm.go`)}
            </Button>
          </>
        }
      >
        {confirm?.kind === 'edit' && editing?.kind === 'edit' ? (
          <p>
            {t(`${P}.confirm.edit-body`, {
              name: editing.model.name,
              methods: methodsOf(editing.model)
                .map((method) => t(`${P}.method.${method}`))
                .join(', '),
            })}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {changes.map((change) => (
              <li key={change.method}>
                {t(`${P}.confirm.line`, {
                  method: t(`${P}.method.${change.method}`),
                  from: change.from,
                  to: change.to,
                })}
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <FleetsCard
        fleets={selection.fleets}
        canManage={canManage}
        csrfToken={csrfToken}
        onSelection={adopt}
      />
    </SettingsPage>
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
