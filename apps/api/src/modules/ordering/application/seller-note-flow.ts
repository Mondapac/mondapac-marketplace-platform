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
import { SellerOrderNoteAdded } from '../domain/audit';
import { parseNoteBody } from '../domain/admin-order-note';
import { isActingAsSession } from './acting-as';
import type { OrderLabels } from './ports/order-labels';
import type {
  NotedSellerOrder,
  SellerNoteCipher,
  SellerOrderNoteRepository,
  StoredSellerNote,
} from './ports/seller-order-notes';

// A seller's own notes on one of its paid seller orders (order detail decision 3): the shop's
// team reads them with the order page's key and writes them with `ordering.seller-order.note`.
// The customer never sees them and neither do the admins (theirs are a separate list). The seller
// comes from the session, never from the request; another shop's seller order answers exactly as
// an unknown one. An acting-as (Login as Seller) session may read them, as it reads the order, but
// never writes one: a note is signed by its author, and the admin behind the session is not a
// member of the shop. The text rules are the admin notes' (1 to 2000 characters, trimmed, no
// hidden characters); the text is sealed under the order's customer account key before it reaches
// the unit, opened after the read, never logged, audited only as its id and length.

export interface SellerNoteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notes: SellerOrderNoteRepository;
  readonly cipher: SellerNoteCipher;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** The authors' names (advisory: a failure shows no name). */
  readonly labels: OrderLabels;
}

export type SellerNoteFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'ordering.seller-order-not-found' }
  /** The customer's account was erased: no note can be written about them any more. */
  | { readonly code: 'ordering.customer-erased' };

/** One note as the seller order page shows it. */
export interface SellerNoteView {
  readonly noteId: Id<'SellerOrderNote'>;
  /** Null when the customer's key was destroyed (the account was erased). */
  readonly body: string | null;
  readonly authorAccountId: Id<'Account'>;
  /** The author's display name as identity lets this member see it; null when unknown. */
  readonly authorName: string | null;
  /** Whether the asking member wrote it. */
  readonly byYou: boolean;
  readonly createdAt: Temporal.Instant;
}

/** The newest notes a page shows (older ones are not paged yet). */
export const SELLER_NOTES_SHOWN = 100;

interface SellerCaller {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
  readonly actingAs: boolean;
}

/** The seller of an authenticated seller session; null for any other actor (fail closed). */
function sellerCallerOf(context: CallContext): SellerCaller | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  const parsed = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
  return parsed !== null && parsed.ok
    ? { sellerId: parsed.value, accountId: actor.accountId, actingAs: isActingAsSession(actor) }
    : null;
}

const parseSellerOrderId = (value: unknown): Id<'SellerOrder'> | null => {
  const parsed = typeof value === 'string' ? parseId<'SellerOrder'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

async function viewsOf(
  deps: SellerNoteDependencies,
  context: CallContext,
  me: Id<'Account'>,
  accountId: Id<'Account'>,
  notes: readonly { readonly note: StoredSellerNote; readonly body?: string }[],
): Promise<readonly SellerNoteView[]> {
  let names: ReadonlyMap<Id<'Account'>, string> = new Map();
  try {
    names = await deps.labels.staffNamesOf(context, [
      ...new Set(notes.map(({ note }) => note.authorAccountId)),
    ]);
  } catch {
    // Advisory: the notes show without names.
  }
  const views: SellerNoteView[] = [];
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

/** The seller order's notes, newest first. Unknown and another shop's seller order are one answer. */
export async function listSellerNotes(
  deps: SellerNoteDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<readonly SellerNoteView[], SellerNoteFailure>> {
  const caller = sellerCallerOf(context);
  if (caller === null) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  if (sellerOrderId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] });
  }
  const read = await deps.unitOfWork.run<
    { readonly owner: NotedSellerOrder; readonly notes: readonly StoredSellerNote[] },
    SellerNoteFailure
  >(
    context.market,
    async () => {
      const owner = await deps.notes.sellerOrderOf(context.market, caller.sellerId, sellerOrderId);
      return owner === null
        ? err({ code: 'ordering.seller-order-not-found' } as const)
        : ok({
            owner,
            notes: await deps.notes.list(
              context.market,
              caller.sellerId,
              sellerOrderId,
              SELLER_NOTES_SHOWN,
            ),
          });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { owner, notes } = read.value;
  return ok(
    await viewsOf(
      deps,
      context,
      caller.accountId,
      owner.accountId,
      notes.map((note) => ({ note })),
    ),
  );
}

/** Writes one note on the seller's own seller order and answers it. */
export async function addSellerNote(
  deps: SellerNoteDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown; readonly body: unknown },
): Promise<Result<SellerNoteView, SellerNoteFailure>> {
  const caller = sellerCallerOf(context);
  if (caller === null || caller.actingAs) return err({ code: 'access.denied' });
  const sellerOrderId = parseSellerOrderId(input?.sellerOrderId);
  const body = parseNoteBody(input?.body);
  if (sellerOrderId === null || !body.ok) {
    return err({
      code: 'validation.failed',
      fields: [
        ...(sellerOrderId === null ? [{ path: 'sellerOrderId', code: 'format' }] : []),
        ...(body.ok ? [] : body.fields),
      ],
    });
  }
  // The seller order is read first, to seal under the customer's key outside the writing unit
  // (as the admin notes do); the insert then checks the same seller order again.
  const owner = await deps.unitOfWork.run<NotedSellerOrder, SellerNoteFailure>(
    context.market,
    async () => {
      const found = await deps.notes.sellerOrderOf(context.market, caller.sellerId, sellerOrderId);
      return found === null ? err({ code: 'ordering.seller-order-not-found' } as const) : ok(found);
    },
    { readOnly: true },
  );
  if (!owner.ok) return owner;
  const sealed = await deps.cipher.seal(context.market, owner.value.accountId, body.body);
  if (!sealed.ok) return err({ code: 'ordering.customer-erased' });
  const note: StoredSellerNote = {
    id: deps.ids.next<'SellerOrderNote'>(),
    orderId: owner.value.orderId,
    sellerOrderId,
    sellerId: caller.sellerId,
    authorAccountId: caller.accountId,
    bodySealed: sealed.value,
    createdAt: deps.clock.now(),
  };
  const written = await deps.unitOfWork.run<true, SellerNoteFailure>(context.market, async () => {
    const again = await deps.notes.sellerOrderOf(context.market, caller.sellerId, sellerOrderId);
    if (again === null || again.accountId !== owner.value.accountId) {
      return err({ code: 'ordering.seller-order-not-found' } as const);
    }
    await deps.notes.insert(context.market, note);
    await deps.audit.record(
      context,
      SellerOrderNoteAdded.entry(sellerOrderId, {
        after: { noteId: note.id, length: Array.from(body.body).length },
      }),
    );
    return ok(true as const);
  });
  if (!written.ok) return written;
  const [view] = await viewsOf(deps, context, caller.accountId, owner.value.accountId, [
    { note, body: body.body },
  ]);
  return ok(view!);
}
