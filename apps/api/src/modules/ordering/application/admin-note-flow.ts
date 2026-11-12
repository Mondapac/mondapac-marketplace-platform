import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { OrderNoteAdded } from '../domain/audit';
import { parseNoteBody } from '../domain/admin-order-note';
import { isActingAsSession } from './acting-as';
import type {
  AdminNoteCipher,
  AdminOrderNoteRepository,
  StoredAdminNote,
} from './ports/admin-order-notes';
import type { OrderLabels } from './ports/order-labels';

// Admins' internal notes on an order (order detail decision 3): read with the order page's key,
// written with `ordering.order.note`. Only an admin session (never an acting-as session) reads or
// writes them. The text is free text about a customer (ordering data design O8): sealed under the
// order's customer account key before it reaches the unit, opened after the read, never logged,
// audited only as its id and length. A destroyed key (the customer was erased) shows the note
// without its text.

export interface AdminNoteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notes: AdminOrderNoteRepository;
  readonly cipher: AdminNoteCipher;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** The authors' names (advisory: a failure shows no name). */
  readonly labels: OrderLabels;
}

export type NoteFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'ordering.order-not-found' }
  /** The customer's account was erased: no note can be written about them any more. */
  | { readonly code: 'ordering.customer-erased' };

/** One note as the admin page shows it. */
export interface AdminNoteView {
  readonly noteId: Id<'AdminOrderNote'>;
  /** Null when the customer's key was destroyed (the account was erased). */
  readonly body: string | null;
  readonly authorAccountId: Id<'Account'>;
  /** The author's display name as identity lets this admin see it; null when unknown. */
  readonly authorName: string | null;
  /** Whether the asking admin wrote it. */
  readonly byYou: boolean;
  readonly createdAt: Temporal.Instant;
}

/** The newest notes a page shows (older ones are not paged yet). */
export const NOTES_SHOWN = 100;

function adminOf(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'admin' && !isActingAsSession(actor)
    ? actor.accountId
    : null;
}

const parseOrderId = (value: unknown): Id<'Order'> | null => {
  const parsed = typeof value === 'string' ? parseId<'Order'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

async function viewsOf(
  deps: AdminNoteDependencies,
  context: CallContext,
  me: Id<'Account'>,
  accountId: Id<'Account'>,
  notes: readonly { readonly note: StoredAdminNote; readonly body?: string }[],
): Promise<readonly AdminNoteView[]> {
  let names: ReadonlyMap<Id<'Account'>, string> = new Map();
  try {
    names = await deps.labels.staffNamesOf(context, [
      ...new Set(notes.map(({ note }) => note.authorAccountId)),
    ]);
  } catch {
    // Advisory: the notes show without names.
  }
  const views: AdminNoteView[] = [];
  for (const { note, body } of notes) {
    let text: string | null = body ?? null;
    if (body === undefined) {
      const opened = await deps.cipher.open(context.market, accountId, note.bodySealed);
      text = opened.ok ? opened.value : null;
    }
    views.push({
      noteId: note.id,
      body: text,
      authorAccountId: note.authorAccountId,
      authorName: names.get(note.authorAccountId) ?? null,
      byYou: note.authorAccountId === me,
      createdAt: note.createdAt,
    });
  }
  return views;
}

/** The order's notes, newest first. Unknown and another Market's order are one answer. */
export async function listAdminNotes(
  deps: AdminNoteDependencies,
  context: CallContext,
  input: { readonly orderId: unknown },
): Promise<Result<readonly AdminNoteView[], NoteFailure>> {
  const me = adminOf(context);
  if (me === null) return err({ code: 'access.denied' });
  const orderId = parseOrderId(input?.orderId);
  if (orderId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'orderId', code: 'format' }] });
  }
  const read = await deps.unitOfWork.run<
    { readonly accountId: Id<'Account'>; readonly notes: readonly StoredAdminNote[] },
    NoteFailure
  >(
    context.market,
    async () => {
      const accountId = await deps.notes.orderAccount(context.market, orderId);
      return accountId === null
        ? err({ code: 'ordering.order-not-found' } as const)
        : ok({ accountId, notes: await deps.notes.list(context.market, orderId, NOTES_SHOWN) });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { accountId, notes } = read.value;
  return ok(
    await viewsOf(
      deps,
      context,
      me,
      accountId,
      notes.map((note) => ({ note })),
    ),
  );
}

/** Writes one note on the order and answers it. */
export async function addAdminNote(
  deps: AdminNoteDependencies,
  context: CallContext,
  input: { readonly orderId: unknown; readonly body: unknown },
): Promise<Result<AdminNoteView, NoteFailure>> {
  const me = adminOf(context);
  if (me === null) return err({ code: 'access.denied' });
  const orderId = parseOrderId(input?.orderId);
  const body = parseNoteBody(input?.body);
  if (orderId === null || !body.ok) {
    return err({
      code: 'validation.failed',
      fields: [
        ...(orderId === null ? [{ path: 'orderId', code: 'format' }] : []),
        ...(body.ok ? [] : body.fields),
      ],
    });
  }
  // The customer is read first, to seal under their key outside the writing unit (as checkout
  // seals the delivery address); the insert then names the same order, so a foreign id fails.
  const owner = await deps.unitOfWork.run<Id<'Account'>, NoteFailure>(
    context.market,
    async () => {
      const accountId = await deps.notes.orderAccount(context.market, orderId);
      return accountId === null
        ? err({ code: 'ordering.order-not-found' } as const)
        : ok(accountId);
    },
    { readOnly: true },
  );
  if (!owner.ok) return owner;
  const sealed = await deps.cipher.seal(context.market, owner.value, body.body);
  if (!sealed.ok) return err({ code: 'ordering.customer-erased' });
  const note: StoredAdminNote = {
    id: deps.ids.next<'AdminOrderNote'>(),
    orderId,
    authorAccountId: me,
    bodySealed: sealed.value,
    createdAt: deps.clock.now(),
  };
  const written = await deps.unitOfWork.run<true, NoteFailure>(context.market, async () => {
    if ((await deps.notes.orderAccount(context.market, orderId)) !== owner.value) {
      return err({ code: 'ordering.order-not-found' } as const);
    }
    await deps.notes.insert(context.market, note);
    await deps.audit.record(
      context,
      OrderNoteAdded.entry(orderId, {
        after: { noteId: note.id, length: Array.from(body.body).length },
      }),
    );
    return ok(true as const);
  });
  if (!written.ok) return written;
  const [view] = await viewsOf(deps, context, me, owner.value, [{ note, body: body.body }]);
  return ok(view!);
}
