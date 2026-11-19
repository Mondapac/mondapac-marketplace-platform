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
  const canEdit = areas.some((area) => area.actions.includes('edit-names'));

  return (
    <SettingsPage title={t('title')}>
      <SettingsSection title={t('section')} description={canEdit ? t('intro') : t('read-only')}>
        <div className="p-5">
          <div className="relative overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-120 text-start text-sm">
              <caption className="sr-only">{t('title')}</caption>
              <thead className="bg-muted text-fg-muted">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                    {t('col.area')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t('col.names')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    <span className="sr-only">{t('col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-row">
                {areas.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-fg-muted">
                      {t('empty')}
                    </td>
                  </tr>
                ) : null}
                {areas.map((area) => {
                  const label = area.names[initial.defaultLanguage]?.name ?? area.code;
                  return (
                    <tr key={area.code}>
                      <td className="px-3 py-3 align-top">
                        <div className="font-medium text-fg">{label}</div>
                        <div className="text-fg-muted">
                          {area.code}
                          {area.region === null ? '' : ` · ${area.region}`}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
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
                      <td className="px-3 py-3 align-top">
                        {ROW_ACTIONS.some((id) => area.actions.includes(id)) ? (
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
