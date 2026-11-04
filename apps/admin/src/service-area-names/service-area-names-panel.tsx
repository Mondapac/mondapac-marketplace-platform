'use client';

import { Badge, Button, SettingsPage, SettingsSection } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { EditNamesDialog } from './edit-names-dialog.tsx';
import { languageLabel } from './errors.ts';
import type { AreaNames, AreaRow } from './types.ts';

/** Settings › Service areas: every area with its names; an admin who may edit changes them. */
export function ServiceAreaNamesPanel({
  initial,
  canEdit,
  csrfToken,
}: {
  readonly initial: AreaNames;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('serviceAreas');
  const [areas, setAreas] = useState(initial.areas);
  const [editing, setEditing] = useState<string | null>(null);
  const editingArea = areas.find((area) => area.code === editing) ?? null;
  const replace = (next: AreaRow) =>
    setAreas((all) => all.map((area) => (area.code === next.code ? next : area)));

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
                        {canEdit ? (
                          <Button
                            variant="secondary"
                            className="min-h-12 whitespace-nowrap"
                            aria-label={t('edit-label', { code: area.code })}
                            onClick={() => setEditing(area.code)}
                          >
                            {t('edit')}
                          </Button>
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
        />
      )}
    </SettingsPage>
  );
}
