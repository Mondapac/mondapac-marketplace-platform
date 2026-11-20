'use client';

import { Badge, Menu, SettingsPage, SettingsSection } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { EditNamesDialog } from './edit-names-dialog.tsx';
import { languageLabel } from './errors.ts';
import { callApi } from '../api/client.ts';
import { AREAS_PATH, ROW_ACTIONS, type AreaNames, type AreaRow } from './types.ts';

/** Settings › Service areas: every area with its names; an admin who may edit changes them. */
export function ServiceAreaNamesPanel({
  initial,
  csrfToken,
}: {
  readonly initial: AreaNames;
  readonly csrfToken: string;
}) {
  const t = useTranslations('serviceAreas');
  const [areas, setAreas] = useState(initial.areas);
  const [editing, setEditing] = useState<string | null>(null);
  const editingArea = areas.find((area) => area.code === editing) ?? null;
  const replace = (next: AreaRow) =>
    setAreas((all) => all.map((area) => (area.code === next.code ? next : area)));
  // After a refused save the row (or the caller's rights) may have changed: read the list again.
  // A failed read keeps what is shown.
  const reload = async () => {
    const result = await callApi<AreaNames>('GET', AREAS_PATH);
    if (result.ok) setAreas(result.body.areas);
  };
  const known = (area: AreaRow) => ROW_ACTIONS.some((id) => area.actions.includes(id));
  const hasActions = areas.some(known);
  // With no rows nothing says what the caller may do, so the neutral intro is shown.
  const readOnly = areas.length > 0 && !hasActions;

  return (
    <SettingsPage title={t('title')}>
      <SettingsSection title={t('section')} description={readOnly ? t('read-only') : t('intro')}>
        <div className="p-5">
          {areas.length === 0 ? (
            <p className="rounded-lg border border-line p-4 text-sm text-fg-muted">{t('empty')}</p>
          ) : (
            <div className="relative overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-start text-sm max-sm:block sm:min-w-120">
                <caption className="sr-only">{t('title')}</caption>
                <thead className="bg-muted text-fg-muted max-sm:hidden">
                  <tr>
                    <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                      {t('col.area')}
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      {t('col.names')}
                    </th>
                    {hasActions ? (
                      <th scope="col" className="px-3 py-3 font-medium">
                        <span className="sr-only">{t('col.actions')}</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-row max-sm:block">
                  {areas.map((area) => {
                    const label = area.names[initial.defaultLanguage]?.name ?? area.code;
                    return (
                      <tr key={area.code} className="max-sm:relative max-sm:block max-sm:p-4">
                        <td className="px-3 py-3 align-top max-sm:block max-sm:p-0 max-sm:pe-12">
                          <div className="font-medium text-fg">{label}</div>
                          <div className="text-fg-muted">
                            {area.code}
                            {area.region === null ? '' : ` · ${area.region}`}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top max-sm:mt-2 max-sm:block max-sm:p-0">
                          <ul className="flex flex-col gap-1">
                            {initial.languages.map((tag) => {
                              const entry = area.names[tag];
                              if (entry === undefined) return null;
                              return (
                                <li key={tag} className="flex flex-wrap items-center gap-2">
                                  <span className="text-fg-muted">{languageLabel(tag)}:</span>
                                  <span dir="auto">{entry.name}</span>
                                  {entry.edited ? (
                                    <Badge tone="attention">{t('edited')}</Badge>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </td>
                        {hasActions ? (
                          <td className="px-3 py-3 align-top max-sm:absolute max-sm:end-2 max-sm:top-2 max-sm:p-0">
                            {known(area) ? (
                              <Menu
                                label={t('actions-for', { name: label })}
                                items={[
                                  {
                                    id: 'edit-names',
                                    label: t('edit'),
                                    onSelect: () => setEditing(area.code),
                                  },
                                ]}
                              />
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsSection>
      {editingArea === null ? null : (
        <EditNamesDialog
          key={editingArea.code}
          area={editingArea}
          config={initial}
          csrfToken={csrfToken}
          onClose={() => setEditing(null)}
          onSaved={replace}
          onRefused={() => void reload()}
        />
      )}
    </SettingsPage>
  );
}
