'use client';

import { Banner, Button, Dialog, LoadError, Select, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { loadActiveAttributes } from './load-active-attributes.ts';
import { useAttributeCall } from './use-attribute-call.ts';
import {
  API_ATTRIBUTES,
  textIn,
  type AttributeDetail,
  type AttributePage,
  type AttributeWrite,
  type ImpactAnswer,
  type ImpactCount,
} from './types.ts';

type ImpactLoad =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly answer: ImpactAnswer }
  | { readonly state: 'failed' };

/**
 * Reads what a change of the attribute would reach (attributes A8). The dialog shows it before
 * the admin confirms, and the version in the answer is the one the confirm names, so a change by
 * someone else meanwhile is refused as stale instead of applied to numbers the admin never saw.
 */
function useImpact(attributeId: string) {
  const [load, setLoad] = useState<ImpactLoad>({ state: 'loading' });
  const latest = useRef(0);
  const fetchImpact = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<ImpactAnswer>(
      'GET',
      `${API_ATTRIBUTES}/${encodeURIComponent(attributeId)}/impact`,
    );
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', answer: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: 'failed' });
  }, [attributeId]);
  useEffect(() => {
    void fetchImpact();
  }, [fetchImpact]);
  return { load, retry: fetchImpact };
}

/** "12", or "At least 10000" when the server stopped counting. */
function CountText({ value }: { readonly value: ImpactCount }) {
  const t = useTranslations('attributes.restructure');
  return <>{value.atLeast ? t('at-least', { count: value.count }) : String(value.count)}</>;
}

/** The impact list of the dialog: what the change reaches, one line each. */
function ImpactList({ answer }: { readonly answer: ImpactAnswer }) {
  const t = useTranslations('attributes.restructure');
  const { impact, attribute } = answer;
  return (
    <dl
      aria-label={t('impact-label')}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm"
    >
      <dt className="text-fg-muted">{t('impact.published')}</dt>
      <dd className="text-end tabular-nums">
        <CountText value={impact.publishedProducts} />
      </dd>
      <dt className="text-fg-muted">{t('impact.drafts')}</dt>
      <dd className="text-end tabular-nums">
        <CountText value={impact.drafts} />
      </dd>
      <dt className="text-fg-muted">{t('impact.feature-sets')}</dt>
      <dd className="text-end tabular-nums">{impact.featureSetCount}</dd>
      <dt className="text-fg-muted">{t('impact.categories')}</dt>
      <dd className="text-end tabular-nums">
        <CountText value={impact.categories} />
      </dd>
      <dt className="text-fg-muted">{t('impact.filters')}</dt>
      <dd className="text-end tabular-nums">
        <CountText value={impact.filters} />
      </dd>
      {attribute.isVariantOption ? (
        <>
          <dt className="text-fg-muted">{t('impact.variants')}</dt>
          <dd className="text-end tabular-nums">
            <CountText value={impact.liveVariantProducts} />
          </dd>
        </>
      ) : null}
      <dt className="text-fg-muted">{t('impact.material')}</dt>
      <dd className="text-end">{attribute.material ? t('yes') : t('no')}</dd>
    </dl>
  );
}

function ImpactBody({
  load,
  retry,
  children,
}: {
  readonly load: ImpactLoad;
  readonly retry: () => Promise<void>;
  readonly children: (answer: ImpactAnswer) => ReactNode;
}) {
  const t = useTranslations('attributes.restructure');
  const tl = useTranslations('load');
  if (load.state === 'loading') return <SkeletonRows label={t('impact-loading')} rows={4} />;
  if (load.state === 'failed') {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('impact-error')}
        retryLabel={tl('retry')}
        onRetry={() => void retry()}
      />
    );
  }
  return <>{children(load.answer)}</>;
}

/**
 * Merge one value of a select attribute into another (attributes A8). The admin picks the two
 * values, reads what the change reaches, and confirms. Products keep what they have; the storefront
 * reads the target for the merged value, and a product's next save stores the target's code.
 */
export function MergeValuesDialog({
  detail,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly detail: AttributeDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('attributes.restructure');
  const te = useTranslations('attributes.editor');
  const call = useAttributeCall(csrfToken);
  const { load, retry } = useImpact(detail.id);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  const usable = detail.options.filter(
    (option) => option.active && (option.mergedInto ?? null) === null,
  );
  const label = (code: string) => {
    const option = detail.options.find((candidate) => candidate.code === code);
    return option === undefined
      ? code
      : textIn(option.labels, detail.locales.default, detail.locales.default, code);
  };
  const choices = usable.map((option) => ({ value: option.code, label: label(option.code) }));
  const ready = load.state === 'ready' && source !== '' && target !== '' && source !== target;

  async function merge(version: number) {
    const answer = await call.run<AttributeWrite>(
      'POST',
      `${API_ATTRIBUTES}/${encodeURIComponent(detail.id)}/merge-values`,
      { version, source, target },
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('merge-title', { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {te('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{te('reload')}</Button>
          ) : (
            <Button
              loading={call.pending}
              disabled={call.pending || !ready}
              onClick={() => {
                if (load.state === 'ready') void merge(load.answer.attribute.version);
              }}
            >
              {t('merge-confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{te(`error.${problem.key}`)}</Banner>}
        <p>{t('merge-body')}</p>
        <Select
          label={t('merge-source')}
          placeholder={t('choose')}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          options={choices.map((choice) => ({ ...choice, disabled: choice.value === target }))}
        />
        <Select
          label={t('merge-target')}
          placeholder={t('choose')}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          options={choices.map((choice) => ({ ...choice, disabled: choice.value === source }))}
        />
        <ImpactBody load={load} retry={retry}>
          {(answer) => <ImpactList answer={answer} />}
        </ImpactBody>
      </div>
    </Dialog>
  );
}

/** What each convertible type becomes (attributes A8): the two listed paths only. */
export const CONVERSIONS: Readonly<Record<string, 'decimal' | 'multi-select'>> = {
  integer: 'decimal',
  select: 'multi-select',
};

/**
 * Convert the type of an attribute (attributes A8), along one of the two listed paths: a whole
 * number to a decimal, a select to a multi-select. The admin reads what the change reaches and
 * confirms. Products keep what they have; their values are read as the new type.
 */
export function ConvertTypeDialog({
  detail,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly detail: AttributeDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('attributes.restructure');
  const te = useTranslations('attributes.editor');
  const call = useAttributeCall(csrfToken);
  const { load, retry } = useImpact(detail.id);
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  const to = CONVERSIONS[detail.dataType];

  async function convert(version: number) {
    if (to === undefined) return;
    const answer = await call.run<AttributeWrite>(
      'POST',
      `${API_ATTRIBUTES}/${encodeURIComponent(detail.id)}/convert`,
      { version, to },
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  // The conversion cannot be undone, so Cancel has the first focus.
  const cancel = useRef<HTMLButtonElement>(null);
  const tt = useTranslations('attributes');
  return (
    <Dialog
      open
      title={t('convert-title', { name })}
      onClose={onClose}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={call.pending} onClick={onClose}>
            {te('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{te('reload')}</Button>
          ) : (
            <Button
              loading={call.pending}
              disabled={call.pending || load.state !== 'ready' || to === undefined}
              onClick={() => {
                if (load.state === 'ready') void convert(load.answer.attribute.version);
              }}
            >
              {t('convert-confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{te(`error.${problem.key}`)}</Banner>}
        {to === undefined ? null : (
          <p className="font-medium">
            {t('convert-from-to', {
              from: tt(`type.${detail.dataType}`),
              to: tt(`type.${to}`),
            })}
          </p>
        )}
        <p>{to === 'decimal' ? t('convert-body-decimal') : t('convert-body-multi-select')}</p>
        <Banner tone="attention">{t('convert-irreversible')}</Banner>
        <ImpactBody load={load} retry={retry}>
          {(answer) => <ImpactList answer={answer} />}
        </ImpactBody>
      </div>
    </Dialog>
  );
}

/**
 * Archive an attribute (attributes A8), after the impact dialog. A `material` attribute is not
 * archived at once: the admin asks, and a different administrator with the same permission
 * confirms under Waiting for you. An attribute in an active feature set, or a variant attribute
 * with live variants, cannot be archived, and the dialog says which.
 */
export function ArchiveDialog({
  detail,
  csrfToken,
  onClose,
  onDone,
  onRequested,
  onReload,
  onOpenWaiting,
}: {
  readonly detail: AttributeDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onRequested: () => void;
  readonly onReload: () => void;
  readonly onOpenWaiting?: () => void;
}) {
  const t = useTranslations('attributes.restructure');
  const te = useTranslations('attributes.editor');
  const call = useAttributeCall(csrfToken);
  const { load, retry } = useImpact(detail.id);
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  const material = detail.material;

  const block =
    load.state !== 'ready'
      ? null
      : load.answer.impact.featureSetCount > 0
        ? 'in-feature-set'
        : load.answer.attribute.isVariantOption && load.answer.impact.liveVariantProducts.count > 0
          ? 'live-variants'
          : null;

  async function send(version: number) {
    const path = `${API_ATTRIBUTES}/${encodeURIComponent(detail.id)}/${material ? 'archive-requests' : 'archive'}`;
    const answer = await call.run('POST', path, { version });
    if (answer.ok) (material ? onRequested : onDone)();
  }

  const problem = call.problem;
  // The archive cannot be undone, so Cancel has the first focus (a request can be withdrawn).
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      title={t(material ? 'archive-request-title' : 'archive-title', { name })}
      onClose={onClose}
      {...(material ? {} : { initialFocus: cancel })}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={call.pending} onClick={onClose}>
            {te('cancel')}
          </Button>
          {problem?.key === 'relaxation-already-open' && onOpenWaiting !== undefined ? (
            <Button onClick={onOpenWaiting}>{t('go-to-waiting')}</Button>
          ) : problem?.reload === true ? (
            <Button onClick={onReload}>{te('reload')}</Button>
          ) : (
            <Button
              variant={material ? 'primary' : 'destructive-solid'}
              loading={call.pending}
              disabled={call.pending || load.state !== 'ready' || block !== null}
              onClick={() => {
                if (load.state === 'ready') void send(load.answer.attribute.version);
              }}
            >
              {t(material ? 'archive-request-send' : 'archive-confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{te(`error.${problem.key}`)}</Banner>}
        {block === null ? null : <Banner tone="attention">{t(`blocked.${block}`)}</Banner>}
        <p>{t(material ? 'archive-request-body' : 'archive-body')}</p>
        <ImpactBody load={load} retry={retry}>
          {(answer) => (
            <>
              <ImpactList answer={answer} />
              {answer.impact.featureSets.length > 0 ? (
                <p className="text-sm text-fg-muted">
                  {t('feature-sets-list', {
                    codes: answer.impact.featureSets.map((set) => set.code).join(', '),
                  })}
                </p>
              ) : null}
            </>
          )}
        </ImpactBody>
      </div>
    </Dialog>
  );
}

type TargetLoad =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly detail: AttributeDetail }
  | { readonly state: 'failed' };

/**
 * Merge an attribute into another of the same type (attributes A8). The admin picks the target
 * from the active attributes of the type, maps every value of a choice attribute to a value of the
 * target, reads what the change reaches and confirms. The merged attribute is archived and points
 * at the target: products keep what they have, and product pages, filters and search read the
 * target. Both versions are the ones the dialog read.
 */
export function MergeAttributesDialog({
  detail,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly detail: AttributeDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('attributes.restructure');
  const te = useTranslations('attributes.editor');
  const tl = useTranslations('load');
  const call = useAttributeCall(csrfToken);
  const { load, retry } = useImpact(detail.id);
  const [candidates, setCandidates] = useState<
    | { readonly state: 'loading' | 'failed' }
    | { readonly state: 'ready'; readonly items: AttributePage['items'] }
  >({ state: 'loading' });
  const [targetId, setTargetId] = useState('');
  const targetTicket = useRef(0);
  const [target, setTarget] = useState<TargetLoad>({ state: 'idle' });
  const [mapping, setMapping] = useState<Readonly<Record<string, string>>>({});
  const name = textIn(detail.names, detail.locales.default, detail.locales.default, detail.code);
  const choice = detail.dataType === 'select' || detail.dataType === 'multi-select';

  const fetchCandidates = useCallback(async () => {
    setCandidates({ state: 'loading' });
    const result = await loadActiveAttributes(detail.dataType);
    if (!result.ok) {
      if (result.status === 401) window.location.assign('/session-ended');
      else setCandidates({ state: 'failed' });
      return;
    }
    setCandidates({
      state: 'ready',
      items: result.items.filter((item) => item.id !== detail.id),
    });
  }, [detail.dataType, detail.id]);
  useEffect(() => {
    void fetchCandidates();
  }, [fetchCandidates]);

  async function choose(id: string) {
    // Only the answer of the latest choice counts, so a quick change never mixes two targets.
    const ticket = ++targetTicket.current;
    setTargetId(id);
    setMapping({});
    if (id === '') {
      setTarget({ state: 'idle' });
      return;
    }
    setTarget({ state: 'loading' });
    const result = await callApi<AttributeDetail>(
      'GET',
      `${API_ATTRIBUTES}/${encodeURIComponent(id)}`,
    );
    if (ticket !== targetTicket.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setTarget({ state: 'failed' });
      return;
    }
    setTarget({ state: 'ready', detail: result.body });
    // A value goes to the target value with the same code when there is one.
    const same = new Set(
      result.body.options
        .filter((option) => option.active && (option.mergedInto ?? null) === null)
        .map((option) => option.code),
    );
    setMapping(
      Object.fromEntries(
        detail.options.filter((option) => same.has(option.code)).map((o) => [o.code, o.code]),
      ),
    );
  }

  const targetOptions =
    target.state === 'ready'
      ? target.detail.options
          .filter((option) => option.active && (option.mergedInto ?? null) === null)
          .map((option) => ({
            value: option.code,
            label: textIn(
              option.labels,
              target.detail.locales.default,
              target.detail.locales.default,
              option.code,
            ),
          }))
      : [];
  const mapped = !choice || detail.options.every((option) => mapping[option.code] !== undefined);
  const ready = load.state === 'ready' && target.state === 'ready' && mapped;

  async function merge(version: number, targetVersion: number) {
    const answer = await call.run<AttributeWrite>(
      'POST',
      `${API_ATTRIBUTES}/${encodeURIComponent(detail.id)}/merge`,
      { version, target: targetId, targetVersion, ...(choice ? { options: mapping } : {}) },
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('merge-attributes-title', { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {te('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{te('reload')}</Button>
          ) : (
            <Button
              loading={call.pending}
              disabled={call.pending || !ready}
              onClick={() => {
                if (load.state === 'ready' && target.state === 'ready') {
                  void merge(load.answer.attribute.version, target.detail.version);
                }
              }}
            >
              {t('merge-attributes-confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{te(`error.${problem.key}`)}</Banner>}
        <p>{t('merge-attributes-body', { name })}</p>
        {candidates.state === 'loading' ? (
          <SkeletonRows rows={1} label={t('merge-attributes-loading')} />
        ) : null}
        {candidates.state === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3"
            message={t('merge-attributes-load-failed')}
            retryLabel={tl('retry')}
            onRetry={() => void fetchCandidates()}
          />
        ) : null}
        {candidates.state === 'ready' && candidates.items.length === 0 ? (
          <Banner tone="info">{t('merge-attributes-none')}</Banner>
        ) : null}
        {candidates.state === 'ready' && candidates.items.length > 0 ? (
          <Select
            label={t('merge-attributes-target')}
            placeholder={t('choose')}
            value={targetId}
            onChange={(event) => void choose(event.target.value)}
            options={candidates.items.map((item) => ({
              value: item.id,
              label: `${textIn(item.names, detail.locales.default, detail.locales.default, item.code)} (${item.code})`,
            }))}
          />
        ) : null}
        {target.state === 'loading' ? (
          <SkeletonRows rows={1} label={t('merge-attributes-loading')} />
        ) : null}
        {target.state === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3"
            message={t('merge-attributes-load-failed')}
            retryLabel={tl('retry')}
            onRetry={() => void choose(targetId)}
          />
        ) : null}
        {choice && target.state === 'ready' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('merge-attributes-map')}</legend>
            {detail.options.map((option) => {
              const value = textIn(
                option.labels,
                detail.locales.default,
                detail.locales.default,
                option.code,
              );
              return (
                <Select
                  key={option.code}
                  label={t('merge-attributes-map-for', { value })}
                  placeholder={t('choose')}
                  value={mapping[option.code] ?? ''}
                  onChange={(event) =>
                    setMapping((current) => {
                      const next = { ...current };
                      if (event.target.value === '') delete next[option.code];
                      else next[option.code] = event.target.value;
                      return next;
                    })
                  }
                  options={targetOptions}
                />
              );
            })}
          </fieldset>
        ) : null}
        <ImpactBody load={load} retry={retry}>
          {(answer) => <ImpactList answer={answer} />}
        </ImpactBody>
      </div>
    </Dialog>
  );
}
