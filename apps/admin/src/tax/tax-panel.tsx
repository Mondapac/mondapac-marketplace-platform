'use client';

import { Badge, Button, EmptyState, SettingsPage, SettingsSection } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { ConfirmDialog, type ConfirmAction } from './confirm-dialog.tsx';
import { StrategyDialog } from './strategy-dialog.tsx';
import { percentOf, TAX_STRATEGIES_PATH, type TaxStrategy, type TaxStrategyList } from './types.ts';

type Open =
  | { readonly kind: 'form'; readonly strategy: TaxStrategy | null }
  | { readonly kind: 'confirm'; readonly action: ConfirmAction };

/**
 * Settings › Tax: the Market's tax strategies and the one in force. The server answers drive the
 * screen: after every change the list is read again, nothing is optimistic. Without the manage key
 * the page is read-only and shows no action.
 */
export function TaxPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: TaxStrategyList;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('tax');
  const kinds = useTranslations('tax.kind');
  const [list, setList] = useState(initial);
  const [open, setOpen] = useState<Open | null>(null);

  async function reload() {
    const fresh = await callApi<TaxStrategyList>('GET', TAX_STRATEGIES_PATH);
    if (fresh.ok) setList(fresh.body);
    else if (fresh.failure.status === 401) window.location.assign('/session-ended');
  }

  const inForce = list.strategies.find((strategy) => strategy.id === list.activeStrategyId);
  const rateOf = (strategy: TaxStrategy) =>
    strategy.kind === 'flat-rate'
      ? percentOf(strategy.rateBps ?? 0)
      : t('rate-by-category', {
          rate: percentOf(strategy.defaultRateBps ?? 0),
          count: Object.keys(strategy.categoryRatesBps ?? {}).length,
        });

  return (
    <SettingsPage title={t('title')}>
      <SettingsSection title={t('section')} description={canManage ? t('intro') : t('read-only')}>
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm text-fg-muted">{t('active-now')}</div>
              <div className="font-medium text-fg">
                {inForce === undefined ? t('built-in') : inForce.name}
                {' · '}
                {inForce === undefined ? percentOf(list.builtInRateBps) : rateOf(inForce)}
              </div>
              {inForce === undefined ? null : (
                <div className="text-sm text-fg-muted">
                  {t('built-in-note', { rate: percentOf(list.builtInRateBps) })}
                </div>
              )}
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                {inForce === undefined ? null : (
                  <Button
                    variant="secondary"
                    className="min-h-12"
                    onClick={() => setOpen({ kind: 'confirm', action: { kind: 'built-in' } })}
                  >
                    {t('back-to-built-in')}
                  </Button>
                )}
                <Button
                  className="min-h-12"
                  onClick={() => setOpen({ kind: 'form', strategy: null })}
                >
                  {t('add')}
                </Button>
              </div>
            ) : null}
          </div>
          {list.strategies.length === 0 ? (
            <EmptyState
              icon="wallet"
              size="compact"
              title={t('empty-title')}
              body={t('empty-body')}
            />
          ) : (
            <div className="relative overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-160 table-fixed text-start text-sm">
                <caption className="sr-only">{t('section')}</caption>
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[14%]" />
                  <col className="w-[16%]" />
                  <col className="w-[12%]" />
                  {canManage ? <col className="w-[34%]" /> : null}
                </colgroup>
                <thead className="bg-muted text-fg-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3 font-medium">
                      {t('col.name')}
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      {t('col.kind')}
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      {t('col.rate')}
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      {t('col.status')}
                    </th>
                    {canManage ? (
                      <th scope="col" className="px-3 py-3 font-medium">
                        <span className="sr-only">{t('col.actions')}</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-row">
                  {list.strategies.map((strategy) => (
                    <tr key={strategy.id}>
                      <td className="break-words px-3 py-3 align-top font-medium text-fg">
                        {strategy.name}
                      </td>
                      <td className="px-3 py-3 align-top">{kinds(strategy.kind)}</td>
                      <td className="px-3 py-3 align-top">{rateOf(strategy)}</td>
                      <td className="px-3 py-3 align-top">
                        <Badge tone={strategy.active ? 'success' : 'neutral'}>
                          {strategy.active ? t('status-active') : t('status-idle')}
                        </Badge>
                      </td>
                      {canManage ? (
                        <td className="px-3 py-3 align-top">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="secondary"
                              className="min-h-12"
                              aria-label={t('edit-label', { name: strategy.name })}
                              onClick={() => setOpen({ kind: 'form', strategy })}
                            >
                              {t('edit')}
                            </Button>
                            {strategy.active ? null : (
                              <>
                                <Button
                                  variant="secondary"
                                  className="min-h-12"
                                  aria-label={t('activate-label', { name: strategy.name })}
                                  onClick={() =>
                                    setOpen({
                                      kind: 'confirm',
                                      action: { kind: 'activate', strategy },
                                    })
                                  }
                                >
                                  {t('activate')}
                                </Button>
                                <Button
                                  variant="destructive"
                                  className="min-h-12"
                                  aria-label={t('delete-label', { name: strategy.name })}
                                  onClick={() =>
                                    setOpen({
                                      kind: 'confirm',
                                      action: { kind: 'delete', strategy },
                                    })
                                  }
                                >
                                  {t('delete')}
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsSection>
      {open?.kind === 'form' ? (
        <StrategyDialog
          strategy={open.strategy}
          categoryCodes={list.categoryCodes}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onSaved={() => void reload()}
          onGone={() => void reload()}
        />
      ) : null}
      {open?.kind === 'confirm' ? (
        <ConfirmDialog
          action={open.action}
          builtInRateBps={list.builtInRateBps}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onChanged={() => void reload()}
        />
      ) : null}
    </SettingsPage>
  );
}
