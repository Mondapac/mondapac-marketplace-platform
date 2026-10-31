'use client';

import { Badge, SettingsSection, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { FleetCode, FleetRow } from './types.ts';

const P = 'fleets';

/** One fleet: whether it is on for the Market, its methods and its admin-set reliability score. */
function FleetItem({
  row,
  canManage,
  text,
  invalid,
  onText,
  onLeave,
}: {
  readonly row: FleetRow;
  readonly canManage: boolean;
  readonly text: string;
  readonly invalid: boolean;
  readonly onText: (value: string) => void;
  readonly onLeave: () => void;
}) {
  const t = useTranslations();
  return (
    <li className="flex flex-col gap-3 border-b border-line-row px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{row.displayName}</h3>
        <Badge tone={row.enabled ? 'success' : 'neutral'}>
          {t(`${P}.fleet.${row.enabled ? 'on' : 'off'}`)}
        </Badge>
      </div>
      <p className="text-sm text-fg-muted">
        {row.enabled && row.methods.length > 0
          ? t(`${P}.fleet.methods`, {
              methods: row.methods.map((method) => t(`${P}.method.${method}`)).join(', '),
            })
          : t(`${P}.fleet.no-methods`)}
      </p>
      {canManage ? (
        <div className="flex flex-col gap-2">
          <TextField
            name={`reliability-${row.fleet}`}
            label={t(`${P}.reliability.label`)}
            help={
              row.reliability === null
                ? t(`${P}.reliability.unset`, { score: row.effectiveReliability })
                : t(`${P}.reliability.help`)
            }
            inputMode="numeric"
            autoComplete="off"
            className="sm:max-w-40"
            value={text}
            error={invalid ? t(`${P}.invalid.score`) : undefined}
            onChange={(event) => onText(event.target.value)}
            onBlur={onLeave}
          />
        </div>
      ) : (
        <p className="text-sm">
          <span className="text-fg-muted">{t(`${P}.reliability.label`)}: </span>
          <strong>{row.effectiveReliability}</strong>
        </p>
      )}
    </li>
  );
}

/** The reliability score of every fleet; its texts are part of the page draft (one save bar). */
export function FleetsCard({
  fleets,
  canManage,
  texts,
  invalid,
  onText,
  onLeave,
}: {
  readonly fleets: readonly FleetRow[];
  readonly canManage: boolean;
  readonly texts: Readonly<Record<FleetCode, string>>;
  readonly invalid: readonly FleetCode[];
  readonly onText: (fleet: FleetCode, value: string) => void;
  readonly onLeave: (fleet: FleetCode) => void;
}) {
  const t = useTranslations();
  return (
    <SettingsSection title={t(`${P}.fleets.title`)} description={t(`${P}.fleets.intro`)}>
      <ul className="flex flex-col">
        {fleets.map((row) => (
          <FleetItem
            key={row.fleet}
            row={row}
            canManage={canManage}
            text={texts[row.fleet]}
            invalid={invalid.includes(row.fleet)}
            onText={(value) => onText(row.fleet, value)}
            onLeave={() => onLeave(row.fleet)}
          />
        ))}
      </ul>
    </SettingsSection>
  );
}
