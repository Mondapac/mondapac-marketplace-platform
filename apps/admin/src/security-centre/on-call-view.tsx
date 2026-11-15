import { Badge, CARD_TABLE, EmptyState } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { displayZone, formatInstantInZone, shortDateInZone } from '../shared/format.ts';
import { SeverityBadge } from './parts.tsx';
import { SEVERITIES, type Channel, type OnCall, type Person } from './types.ts';

/** Only email is delivered today; the other channels answer "not set up" (SOC package 2). */
const WORKING_CHANNELS: ReadonlySet<Channel> = new Set(['email']);

const WHO = { s1: 'who-s1', s2: 'who-s2', s3: 'who-digest', s4: 'who-digest' } as const;

/**
 * The On call tab (design v3, screen 4): who is on call now, the critical escalation chain, the
 * next four weeks and who hears what. Names only: the roster's contact details stay on the server.
 * The roster is server configuration, so the tab has no actions.
 */
export async function OnCallView({
  onCall,
  locale,
  now,
}: {
  readonly onCall: OnCall;
  readonly locale: string;
  readonly now: string;
}) {
  const t = await getTranslations('security-centre.on-call');
  const tc = await getTranslations('security-centre.channel');
  if (!onCall.configured || onCall.zone === null) {
    return <EmptyState icon="users" title={t('empty-title')} body={t('empty')} />;
  }
  const zone = onCall.zone;
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(Date.parse(now));
  const hours = onCall.businessHours;
  const [thisWeek, nextWeek] = onCall.rotation;
  const name = (person: Person | null) => person?.name ?? '-';
  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="on-call-now"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="on-call-now" className="text-sm font-medium text-fg-muted">
          {t('now')}
        </h2>
        <p className="mt-1 text-xl font-semibold">{name(onCall.onCall)}</p>
        {thisWeek !== undefined && nextWeek !== undefined ? (
          <p className="mt-1 text-sm text-fg-muted">
            {t('since', {
              start: formatInstantInZone(thisWeek.startsAt, locale, zone),
              end: formatInstantInZone(nextWeek.startsAt, locale, zone),
            })}
          </p>
        ) : null}
        <p className="mt-3 text-sm">{t('clock', { zone: displayZone(zone), time: clock })}</p>
        {hours !== null ? (
          <p className="mt-1 text-sm text-fg-muted">
            {t(onCall.inBusinessHours === true ? 'in-hours' : 'out-hours', {
              start: hours.start,
              end: hours.end,
            })}
          </p>
        ) : null}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-fg-muted">{t('commander')}</dt>
            <dd className="font-medium">{name(onCall.incidentCommander)}</dd>
          </div>
          <div>
            <dt className="text-sm text-fg-muted">{t('owner')}</dt>
            <dd className="font-medium">{name(onCall.securityOwner)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-sm text-fg-muted">
          {t('resolves')}:{' '}
          {t('or', { a: name(onCall.incidentCommander), b: name(onCall.securityOwner) })}
        </p>
      </section>

      <section
        aria-labelledby="on-call-chain"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="on-call-chain" className="text-lg font-semibold">
          {t('escalation')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {t('escalation-help', {
            minutes: onCall.escalationIntervalMinutes,
            steps: onCall.escalationMaxSteps,
          })}
        </p>
        <ol className="mt-3 flex flex-col gap-2">
          {onCall.escalation.map((person, index) => (
            <li key={`${person.code}-${String(index)}`} className="flex items-baseline gap-3">
              <span className="w-16 shrink-0 text-sm tabular-nums text-fg-muted">
                {index === 0
                  ? t('step-now')
                  : t('step-plus', { minutes: index * onCall.escalationIntervalMinutes })}
              </span>
              <span className="font-medium">{person.name}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-fg-muted">{t('escalation-after')}</p>
      </section>

      <section
        aria-labelledby="on-call-rotation"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="on-call-rotation" className="text-lg font-semibold">
          {t('rotation')}
        </h2>
        <ul className="mt-3 divide-y divide-line-row">
          {onCall.rotation.map((week, index) => (
            <li key={week.startsAt} className="flex items-baseline justify-between gap-3 py-2">
              <span className="text-sm text-fg-muted">
                {index === 0
                  ? t('this-week')
                  : t('from', { date: shortDateInZone(week.startsAt, locale, zone) })}
              </span>
              <span className="font-medium">{week.name}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-fg-muted">{t('roster-note')}</p>
      </section>

      <section aria-labelledby="on-call-channels">
        <h2 id="on-call-channels" className="mb-3 text-lg font-semibold">
          {t('channels')}
        </h2>
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <thead className={CARD_TABLE.head}>
              <tr>
                {(['col-severity', 'col-who', 'col-when', 'col-channels'] as const).map((col) => (
                  <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {SEVERITIES.map((severity) => (
                <tr key={severity} className={CARD_TABLE.row}>
                  <th scope="row" className={`${CARD_TABLE.cell} text-start font-normal`}>
                    <SeverityBadge severity={severity} />
                  </th>
                  <td className={CARD_TABLE.labelled} data-label={t('col-who')}>
                    <span>{t(WHO[severity])}</span>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col-when')}>
                    <span>{t(`when-${severity}`)}</span>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col-channels')}>
                    <span className="flex flex-wrap gap-2">
                      <Badge tone="neutral">
                        {t(severity === 's3' || severity === 's4' ? 'digest' : 'page')}
                      </Badge>
                      {(severity === 's3' || severity === 's4'
                        ? []
                        : onCall.channels[severity]
                      ).map((channel) => (
                        <Badge
                          key={channel}
                          tone={WORKING_CHANNELS.has(channel) ? 'success' : 'neutral'}
                        >
                          {t(WORKING_CHANNELS.has(channel) ? 'working' : 'not-set-up', {
                            channel: tc(channel),
                          })}
                        </Badge>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
