'use client';

import { Banner, Button, Dialog, LoadError, Select, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { useAttributeCall } from './use-attribute-call.ts';
import {
  API_ATTRIBUTES,
  textIn,
  type AttributeDetail,
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
  return (
    <Dialog
      open
      title={t(material ? 'archive-request-title' : 'archive-title', { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
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
