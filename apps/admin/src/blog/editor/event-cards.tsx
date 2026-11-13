'use client';

import { Banner, Button, Select, TextAreaField, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../../api/client.ts';
import { API_BLOG_POSTS } from '../types.ts';
import { editorProblemOf, reasonFor, type EditorProblem } from './editor-errors.ts';
import {
  ATTENDANCES,
  EVENT_LIMITS,
  EVENT_STATUSES,
  eventStatusOf,
  type Attendance,
  type EventForm,
  type EventStatus,
} from './event-model.ts';

/**
 * The event details of an event post (design A5): when it starts and ends on the clock of the
 * event's own zone, how people attend, where, and the one registration link a post may carry.
 */
export function EventDetailsCard({
  form,
  disabled,
  problem,
  onChange,
}: {
  readonly form: EventForm;
  readonly disabled: boolean;
  readonly problem: EditorProblem | null;
  readonly onChange: (next: EventForm) => void;
}) {
  const t = useTranslations('blog.editor.event');
  const set = (patch: Partial<EventForm>) => onChange({ ...form, ...patch });
  const bad = (path: string) => {
    const code = reasonFor(problem, `content.event.${path}`);
    if (code === undefined) return undefined;
    return t.has(`invalid.${code}`) ? t(`invalid.${code}`) : t('invalid.value');
  };
  return (
    <section
      aria-label={t('title')}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <p className="text-sm text-fg-muted">{t('help')}</p>
      <TextField
        label={t('starts-at')}
        type="datetime-local"
        value={form.startsAt}
        disabled={disabled}
        error={bad('startsAt')}
        onChange={(event) => set({ startsAt: event.target.value })}
      />
      <TextField
        label={t('ends-at')}
        type="datetime-local"
        value={form.endsAt}
        disabled={disabled}
        error={bad('endsAt')}
        onChange={(event) => set({ endsAt: event.target.value })}
      />
      <TextField
        label={t('time-zone')}
        help={t('time-zone-help')}
        value={form.timeZone}
        disabled={disabled}
        error={bad('timeZone')}
        onChange={(event) => set({ timeZone: event.target.value })}
      />
      <Select
        label={t('attendance')}
        value={form.attendance}
        disabled={disabled}
        options={ATTENDANCES.map((value) => ({ value, label: t(`attendance-option.${value}`) }))}
        onChange={(event) => set({ attendance: event.target.value as Attendance })}
      />
      <TextField
        label={t('venue')}
        optionalLabel={form.attendance === 'online' ? t('optional') : undefined}
        value={form.venueName}
        maxLength={EVENT_LIMITS.venueName}
        disabled={disabled}
        error={bad('venueName')}
        onChange={(event) => set({ venueName: event.target.value })}
      />
      <TextField
        label={t('address')}
        optionalLabel={t('optional')}
        value={form.address}
        maxLength={EVENT_LIMITS.address}
        disabled={disabled}
        error={bad('address')}
        onChange={(event) => set({ address: event.target.value })}
      />
      <TextField
        label={t('registration')}
        optionalLabel={t('optional')}
        help={t('registration-help')}
        type="url"
        value={form.registrationUrl}
        maxLength={EVENT_LIMITS.registrationUrl}
        disabled={disabled}
        error={bad('registrationUrl')}
        onChange={(event) => set({ registrationUrl: event.target.value })}
      />
    </section>
  );
}

/**
 * The live status of a published event: it changes at once, without a review, and is audited. The
 * note readers see goes through the automatic checks first.
 */
export function EventStatusCard({
  postId,
  event,
  canEdit,
  csrfToken,
  onChanged,
}: {
  readonly postId: string;
  readonly event: Readonly<Record<string, unknown>> | null;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** Called after a change, to show what the API now holds. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('blog.editor.event');
  const te = useTranslations('blog.editor');
  const current = eventStatusOf(event);
  const [status, setStatus] = useState<EventStatus>(current.status);
  const [message, setMessage] = useState(current.message);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const changed = status !== current.status || message.trim() !== current.message;

  async function onSave() {
    if (busy) return;
    setBusy(true);
    const result = await callApi<unknown>(
      'PUT',
      `${API_BLOG_POSTS}/${postId}/event-status`,
      { status, message: message.trim() === '' ? null : message.trim() },
      csrfToken,
    );
    setBusy(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setProblem(editorProblemOf(result.failure));
      return;
    }
    setProblem(null);
    toast.success(t('status-saved'));
    onChanged();
  }

  return (
    <section
      aria-label={t('status-title')}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="text-base font-semibold">{t('status-title')}</h2>
      <p className="text-sm text-fg-muted">{t('status-help')}</p>
      {problem !== null ? (
        <Banner tone="critical">{te(problem.key.replace('blog.editor.', ''))}</Banner>
      ) : null}
      <Select
        label={t('status')}
        value={status}
        disabled={!canEdit || busy}
        options={EVENT_STATUSES.map((value) => ({ value, label: t(`status-option.${value}`) }))}
        onChange={(event) => setStatus(event.target.value as EventStatus)}
      />
      <TextAreaField
        label={t('status-message')}
        optionalLabel={t('optional')}
        help={t('status-message-help')}
        rows={3}
        value={message}
        maxLength={EVENT_LIMITS.message}
        disabled={!canEdit || busy}
        counter={`${message.length} / ${EVENT_LIMITS.message}`}
        onChange={(event) => setMessage(event.target.value)}
      />
      {canEdit ? (
        <Button loading={busy} disabled={!changed} onClick={() => void onSave()}>
          {t('status-save')}
        </Button>
      ) : null}
    </section>
  );
}
