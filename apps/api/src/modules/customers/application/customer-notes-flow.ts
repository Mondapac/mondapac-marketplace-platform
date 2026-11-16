import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { CustomerNoteAdded } from '../domain/audit';
import {
  CUSTOMER_NOTES_PAGE_MAX,
  parseCustomerNoteBody,
  type StoredCustomerNote,
} from '../domain/customer-note';
import type { CustomerManagementDependencies } from './customer-management-dependencies';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  type ListValidationFailure,
} from './customer-list-flow';
import { accountIdOf } from './customer-page-flow';

// Admins' internal notes about a customer (phase 2, PR 2a). The text is free text about a person:
// sealed under the customer account's key before it reaches the unit, opened after the read,
// never logged, audited only as its id and length. A destroyed key (the customer was erased)
// shows a note without its text.

export type NoteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'customers.customer-not-found' }
  | ListValidationFailure;

/** One note as the customer page shows it. */
export interface CustomerNoteView {
  readonly noteId: string;
  /** Null when the customer's key was destroyed (the account was erased). */
  readonly body: string | null;
  readonly authorAccountId: string;
  /** The author's display name as identity names admins; null when unknown. */
  readonly authorName: string | null;
  /** Whether the asking admin wrote it. */
  readonly byYou: boolean;
  readonly createdAt: string;
}

export interface CustomerNotesPage {
  readonly items: readonly CustomerNoteView[];
  readonly total: number;
  /** The cursor of the next (older) page, or null on the last page. */
  readonly nextCursor: string | null;
}

/** Names of the admins who wrote something (advisory: a failure shows no names). */
export async function adminNames(
  deps: CustomerManagementDependencies,
  context: CallContext,
  accountIds: readonly Id<'Account'>[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return new Map();
  try {
    const named = await deps.identity.changeActors(context, unique.slice(0, 100));
    if (!named.ok) return new Map();
    return new Map(
      named.value.flatMap((label) =>
        label.displayName === null ? [] : [[label.accountId as string, label.displayName]],
      ),
    );
  } catch {
    return new Map();
  }
}

const CURSOR = /^n(\d{13})\.([0-9a-f-]{36})$/;

function cursorOf(value: unknown) {
  if (value === undefined || value === null || value === '') return ok(null);
  const match = typeof value === 'string' ? CURSOR.exec(value) : null;
  if (match === null) return invalidField('cursor', 'format');
  return ok({ createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: match[2]! });
}

const cursorFor = (note: StoredCustomerNote): string =>
  `n${String(note.createdAt.epochMilliseconds).padStart(13, '0')}.${note.id}`;

/** The customer's notes, newest first, a page at a time (keyset cursor). */
export async function listNotes(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerNotesPage, NoteFailure>> {
  const me = adminAccountOf(context);
  if (me === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalidField('query', 'type');
  for (const key of Object.keys(input)) {
    if (!['accountId', 'cursor', 'limit'].includes(key)) return invalidField(key, 'unknown');
  }
  const accountId = accountIdOf(input['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const after = cursorOf(input['cursor']);
  if (!after.ok) return after;
  let limit = 20;
  if (input['limit'] !== undefined) {
    const parsed = typeof input['limit'] === 'string' ? Number(input['limit']) : input['limit'];
    if (
      typeof parsed !== 'number' ||
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > CUSTOMER_NOTES_PAGE_MAX
    ) {
      return invalidField('limit', 'range');
    }
    limit = parsed;
  }
  const read = await deps.unitOfWork.run<
    { readonly notes: readonly StoredCustomerNote[]; readonly total: number },
    NoteFailure
  >(
    context.market,
    async () => {
      const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
      if (row === undefined) return err({ code: 'customers.customer-not-found' });
      const [notes, total] = await Promise.all([
        deps.notes.page(context.market, accountId, after.value, limit + 1),
        deps.notes.count(context.market, accountId),
      ]);
      return ok({ notes, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const shown = read.value.notes.slice(0, limit);
  const names = await adminNames(
    deps,
    context,
    shown.map((note) => note.authorAccountId),
  );
  const items: CustomerNoteView[] = [];
  for (const note of shown) {
    const opened = await deps.noteCipher.open(context.market, accountId, note.bodySealed);
    items.push({
      noteId: note.id,
      body: opened.ok ? opened.value : null,
      authorAccountId: note.authorAccountId,
      authorName: names.get(note.authorAccountId) ?? null,
      byYou: note.authorAccountId === me,
      createdAt: note.createdAt.toString(),
    });
  }
  const last = shown.at(-1);
  return ok({
    items,
    total: read.value.total,
    nextCursor: read.value.notes.length > limit && last !== undefined ? cursorFor(last) : null,
  });
}

/**
 * Writes one note about the customer. The text is sealed under the customer's key outside the
 * writing unit; the unit checks the customer is still in the directory, inserts, writes the audit
 * row (the note's id and length) and the timeline entry.
 */
export async function addNote(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerNoteView, NoteFailure>> {
  const me = adminAccountOf(context);
  if (me === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (key !== 'accountId' && key !== 'body') return invalidField(key, 'unknown');
  }
  const accountId = accountIdOf(input['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const body = parseCustomerNoteBody(input['body']);
  if (!body.ok) return invalidField(body.error.path, body.error.code);
  // The directory first (read-only, no transaction): an id that is no customer of this Market is
  // not-found before any key is touched, so the answer never depends on who holds a key.
  const known = await deps.unitOfWork.run<true, NoteFailure>(
    context.market,
    async () => {
      const [found] = await deps.listReader.rowsByIds(context.market, [accountId]);
      return found === undefined ? err({ code: 'customers.customer-not-found' }) : ok(true);
    },
    { readOnly: true },
  );
  if (!known.ok) return known;
  const sealed = await deps.noteCipher.seal(context.market, accountId, body.value);
  // No key: the account was erased meanwhile.
  if (!sealed.ok) return err({ code: 'customers.customer-not-found' });
  const now = deps.clock.now();
  const note: StoredCustomerNote = {
    id: deps.ids.next<'CustomerNote'>(),
    accountId,
    authorAccountId: me,
    bodySealed: sealed.value,
    createdAt: now,
  };
  const written = await deps.unitOfWork.run<true, NoteFailure>(context.market, async () => {
    const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
    if (row === undefined) return err({ code: 'customers.customer-not-found' });
    await deps.notes.insert(context.market, note);
    await deps.audit.record(
      context,
      CustomerNoteAdded.entry(accountId, {
        after: { noteId: note.id, length: Array.from(body.value).length },
      }),
    );
    await deps.timeline.record(
      context.market,
      {
        id: deps.ids.next<'CustomerTimelineEntry'>(),
        accountId,
        occurredAt: now,
        kind: 'note-added',
        ref: { type: 'note', id: note.id },
        actorAccountId: me,
        detail: null,
        sourceEventId: null,
      },
      now,
    );
    return ok(true);
  });
  if (!written.ok) return written;
  const names = await adminNames(deps, context, [me]);
  return ok({
    noteId: note.id,
    body: body.value,
    authorAccountId: me,
    authorName: names.get(me) ?? null,
    byYou: true,
    createdAt: now.toString(),
  });
}
