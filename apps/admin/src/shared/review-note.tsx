'use client';

import { Banner, TextAreaField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ApiFailure } from '../api/client.ts';

/** The most characters the API takes in a note for reviewers (1 to 500). */
export const REVIEW_NOTE_MAX = 500;

/** The review request a change opened in Admin Inbox > System requests; null when none. */
export interface ReviewRequestRef {
  readonly id: string;
  readonly number: number;
}

/** The note as it is sent: trimmed, or null when it is empty. */
export function trimmedNote(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** True when a 400 names the `note` field, so the field (not the page) shows the error. */
export function isNoteFailure(failure: ApiFailure): boolean {
  return (
    failure.status === 400 &&
    failure.code === 'validation.failed' &&
    (failure.details?.fields ?? []).some((field) => field.path === 'note')
  );
}

/** The request number as people read it: "SR-123". */
export const requestLabel = (request: ReviewRequestRef): string => `SR-${request.number}`;

/** The `request` of a change answer, or null when it opened none. */
export function requestOf(body: unknown): ReviewRequestRef | null {
  if (typeof body !== 'object' || body === null) return null;
  const request = (body as { request?: unknown }).request;
  if (typeof request !== 'object' || request === null) return null;
  const { id, number } = request as { id?: unknown; number?: unknown };
  return typeof id === 'string' && typeof number === 'number' ? { id, number } : null;
}

/**
 * The proposal an action answered when it waits for another admin's approval (HTTP 202 with only
 * `{request}`; nothing changed), or null when the action was done.
 */
export function proposalOf(body: unknown): ReviewRequestRef | null {
  if (typeof body !== 'object' || body === null) return null;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === 'request' ? requestOf(body) : null;
}

/**
 * Says an action was sent for approval ("Sent for approval (SR-n)"), when its answer is a
 * proposal. Returns whether it was one: the caller then keeps the item as it is.
 */
export function useSentForApproval(): (body: unknown) => boolean {
  const t = useTranslations('review-note');
  return (body) => {
    const request = proposalOf(body);
    if (request === null) return false;
    toast.info(t('sent-for-approval', { number: requestLabel(request) }));
    return true;
  };
}

/**
 * Says a change was sent for review, when its answer carries a request. The System requests
 * screen has no route in this panel yet, so the toast is text only. Returns whether it showed.
 */
export function useSentForReview(): (body: unknown) => boolean {
  const t = useTranslations('review-note');
  return (body) => {
    const request = requestOf(body);
    if (request === null) return false;
    toast.info(t('sent', { number: requestLabel(request) }));
    return true;
  };
}

/** The label of an action that only files a request for approval: "Send for approval". */
export function useApprovalAction(): (label: string, approval: boolean) => string {
  const t = useTranslations('review-note');
  return (label, approval) => (approval ? t('send-for-approval') : label);
}

/** Says that an action waiting for approval changes nothing until another admin approves it. */
export function ApprovalNotice() {
  const t = useTranslations('review-note');
  return <Banner tone="info">{t('approval-body')}</Banner>;
}

/** The "Note for reviewers" field: multi-line, up to 500 characters, with a counter. */
export function ReviewNoteField({
  value,
  onChange,
  error,
  disabled,
  approval,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Which of the field's own messages to show. */
  readonly error?: 'required' | 'rejected' | undefined;
  readonly disabled?: boolean;
  /** The action waits for another admin's approval (nothing changes until then). */
  readonly approval?: boolean;
}) {
  const t = useTranslations('review-note');
  return (
    <TextAreaField
      name="note"
      label={t('label')}
      help={t(approval === true ? 'help-approval' : 'help')}
      rows={3}
      maxLength={REVIEW_NOTE_MAX}
      value={value}
      disabled={disabled === true}
      counter={t('counter', { count: value.length, max: REVIEW_NOTE_MAX })}
      error={error === undefined ? undefined : t(`error.${error}`)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
