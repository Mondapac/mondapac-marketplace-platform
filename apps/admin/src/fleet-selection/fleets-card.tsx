'use client';

import { Badge, Banner, Button, Card, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { fleetProblemOf } from './errors.ts';
import { scoreOf } from './form.ts';
import { FLEET_SELECTION_PATH, type FleetRow, type Selection } from './types.ts';

const P = 'fleets';

/** One fleet: whether it is on for the Market, its methods and its admin-set reliability score. */
function FleetItem({
  row,
  canManage,
  csrfToken,
  onSelection,
}: {
  readonly row: FleetRow;
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly onSelection: (next: Selection) => void;
}) {
  const t = useTranslations();
  const [text, setText] = useState(row.reliability === null ? '' : String(row.reliability));
  const [invalid, setInvalid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setSaved(false);
    setProblem(null);
    const score = scoreOf(text);
    if (score === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    busy.current = true;
    setPending(true);
    const result = await callApi<Selection>(
      'PUT',
      `${FLEET_SELECTION_PATH}/fleets/${row.fleet}/reliability`,
      { score },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onSelection(result.body);
      setSaved(true);
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      setProblem(fleetProblemOf(result.failure));
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-md border border-line p-4">
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
      {saved ? <Banner tone="success">{t(`${P}.reliability.saved`)}</Banner> : null}
      {problem === null ? null : <Banner tone="critical">{t(`${P}.error.${problem}`)}</Banner>}
      {canManage ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
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
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" variant="secondary" loading={pending}>
            {t(`${P}.reliability.save`)}
          </Button>
        </form>
      ) : (
        <p className="text-sm">
          <span className="text-fg-muted">{t(`${P}.reliability.label`)}: </span>
          <strong>{row.effectiveReliability}</strong>
        </p>
      )}
    </li>
  );
}

export function FleetsCard({
  fleets,
  canManage,
  csrfToken,
  onSelection,
}: {
  readonly fleets: readonly FleetRow[];
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly onSelection: (next: Selection) => void;
}) {
  const t = useTranslations();
  return (
    <Card title={t(`${P}.fleets.title`)}>
      <p className="text-sm text-fg-muted">{t(`${P}.fleets.intro`)}</p>
      <ul className="flex flex-col gap-3">
        {fleets.map((row) => (
          <FleetItem
            key={row.fleet}
            row={row}
            canManage={canManage}
            csrfToken={csrfToken}
            onSelection={onSelection}
          />
        ))}
      </ul>
    </Card>
  );
}
