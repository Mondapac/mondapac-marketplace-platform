import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { SellerAttributionDecided, SellerInviteLinkDrawn } from '../domain/audit';
import { CUSTOMER_MAX_PAGED_ROWS } from '../domain/customer-list';
import { SellerAttributionChangedEvent } from '../domain/events';
import {
  ATTRIBUTION_FLAGS,
  ATTRIBUTION_REJECT_REASONS,
  ATTRIBUTION_STATUSES,
  decideAttribution,
  decideClaim,
  isInviteToken,
  normalizeInviteToken,
  type AttributionStatus,
  type InvitationRules,
  type InviteLink,
  type SellerAttribution,
} from '../domain/seller-invitations';
import type { CustomerReadModelRepository } from './ports/customer-read-models.repository';
import type { InvitationPeers } from './ports/invitation-peers';
import type { SheetWriter } from './ports/sheet-writer';
import {
  ATTRIBUTION_VIEWS,
  type AttributionListRecord,
  type AttributionSelector,
  type AttributionView,
  type InviteLinkRepository,
  type InviteTokens,
  type SellerAttributionRepository,
} from './ports/seller-invitations.repository';
import { adminOfCall, invalid, isRecord, sellerOfCall } from './seller-customers-flow';

// Sellers' invite links and the exclusive customer (customers management phase 4a; plan sections
// 6, 7 and 7b). A seller's team member draws the shop's link; a visitor opens it, signs up and,
// once signed in (the email is verified: an unverified account cannot sign in), claims it; the
// claim records the attribution, follows the store for the customer, and the seller's customers
// read model marks the customer exclusive. An admin reads every attribution (the "suspicious"
// view first) and may reject one or restore it. Plain functions: use cases cannot extend one
// another.

/** The Market's invite link rules, or null when the Market has none (the feature is off). */
export interface InvitationRulesSource {
  rulesOf(market: CallContext['market']): InvitationRules | null;
}

export const INVITATION_RULES = Symbol('CUSTOMERS_INVITATION_RULES');

export interface InvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inviteLinks: InviteLinkRepository;
  readonly attributions: SellerAttributionRepository;
  readonly readModels: CustomerReadModelRepository;
  readonly tokens: InviteTokens;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly invitationPeers: InvitationPeers;
  readonly invitationRules: InvitationRulesSource;
  /** The admin export's step-up proof and its XLSX writer. */
  readonly stepUp: StepUpProofConsumer;
  readonly sheetWriter: SheetWriter;
}

export type InvitationFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** An unknown or revoked link, or a store the public cannot see now. */
  | { readonly code: 'customers.invitation-not-found' }
  /** Attributed already, signed up too long ago, ordered already, or on the store's own team. */
  | { readonly code: 'customers.invitation-not-eligible' }
  | { readonly code: 'customers.unavailable' };

/** The signed-in customer of a call; null for any other actor and in a Login-as session. */
function customerOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'customer') return null;
  if (Object.hasOwn(actor, 'actingAs') && (actor as { actingAs?: unknown }).actingAs != null) {
    return null;
  }
  return actor.accountId;
}

const DAY_HOURS = 24;
/** Tokens drawn for a refresh before it gives up (130 random bits: never reached). */
const TOKEN_ATTEMPTS = 4;

// ---------------------------------------------------------------------------------------------
// The seller's invite link

export interface InviteLinkView {
  /** The seller's live link; null until a team member draws one. */
  readonly link: {
    readonly token: string;
    readonly createdAt: string;
  } | null;
  /** Customers who joined through any of the shop's links: active, and rejected. */
  readonly signups: Readonly<Record<AttributionStatus, number>>;
}

const linkView = (link: InviteLink | null) =>
  link === null ? null : { token: link.token, createdAt: link.createdAt.toString() };

/** The shop's live invite link and how many customers joined through it. */
export async function viewInviteLink(
  deps: InvitationDependencies,
  context: CallContext,
): Promise<Result<InviteLinkView, InvitationFailure>> {
  const sellerId = sellerOfCall(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  if (deps.invitationRules.rulesOf(context.market) === null) {
    return err({ code: 'customers.unavailable' });
  }
  const read = await deps.unitOfWork.run<InviteLinkView, InvitationFailure>(
    context.market,
    async () => {
      const [link, signups] = await Promise.all([
        deps.inviteLinks.liveOf(context.market, sellerId),
        deps.attributions.countsOfSeller(context.market, sellerId),
      ]);
      return ok({ link: linkView(link), signups });
    },
    { readOnly: true },
  );
  return read.ok ? read : err({ code: 'customers.unavailable' });
}

/**
 * Draws a new invite link for the shop. The live one, if any, is revoked in the same unit: its
 * QR codes stop working, and the customers who joined through it stay attributed. Audited.
 */
export async function refreshInviteLink(
  deps: InvitationDependencies,
  context: CallContext,
): Promise<Result<InviteLinkView, InvitationFailure>> {
  const sellerId = sellerOfCall(context);
  const { actor } = context;
  if (sellerId === null || actor.kind !== 'authenticated') return err({ code: 'access.denied' });
  if (deps.invitationRules.rulesOf(context.market) === null) {
    return err({ code: 'customers.unavailable' });
  }
  const { market } = context;
  return deps.unitOfWork.run<InviteLinkView, InvitationFailure>(market, async () => {
    const previous = await deps.inviteLinks.liveOf(market, sellerId);
    const now = deps.clock.now();
    let drawn: InviteLink | null = null;
    for (let attempt = 0; drawn === null && attempt < TOKEN_ATTEMPTS; attempt += 1) {
      const token = deps.tokens.next();
      if (!isInviteToken(token)) throw new Error('customers.invite-links: a malformed token');
      if ((await deps.inviteLinks.findByToken(market, token)) !== null) continue;
      drawn = {
        id: deps.ids.next<'SellerInviteLink'>(),
        sellerId,
        token,
        createdByAccountId: actor.accountId,
        createdAt: now,
        revokedAt: null,
      };
    }
    if (drawn === null) throw new Error('customers.invite-links: no free token');
    if ((await deps.inviteLinks.replace(market, drawn, now)) === 'conflict') {
      return err({ code: 'customers.unavailable' });
    }
    await deps.audit.record(
      context,
      SellerInviteLinkDrawn.entry(drawn.id, {
        after: { sellerId, replacedLinkId: previous === null ? null : previous.id },
      }),
    );
    return ok({
      link: linkView(drawn),
      signups: await deps.attributions.countsOfSeller(market, sellerId),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The storefront

/** The live link of a token and the store it leads to, if the public can see the store now. */
async function liveStoreOf(
  deps: InvitationDependencies,
  context: CallContext,
  token: string,
): Promise<Result<{ readonly link: InviteLink; readonly slug: string }, InvitationFailure>> {
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.inviteLinks.findByToken(context.market, token)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'customers.unavailable' });
  const link = read.value;
  if (link === null || link.revokedAt !== null)
    return err({ code: 'customers.invitation-not-found' });
  const slugs = await deps.invitationPeers.sellers.publishedStoreSlugs(context, [link.sellerId]);
  if (!slugs.ok) return err({ code: 'customers.unavailable' });
  const slug = slugs.value.get(link.sellerId);
  if (slug === undefined) return err({ code: 'customers.invitation-not-found' });
  return ok({ link, slug });
}

/**
 * The store an invite link leads to, for the storefront's invite banner and sign-up line: its
 * address only (the storefront reads the store page by it). Anonymous. An unknown, malformed or
 * revoked token and a store the public cannot see now are one answer, `invitation-not-found`.
 */
export async function resolveInvitation(
  deps: InvitationDependencies,
  context: CallContext,
  input: { readonly token?: unknown },
): Promise<Result<{ readonly slug: string }, InvitationFailure>> {
  if (deps.invitationRules.rulesOf(context.market) === null) {
    return err({ code: 'customers.invitation-not-found' });
  }
  const token = normalizeInviteToken(input?.token);
  if (token === null) return err({ code: 'customers.invitation-not-found' });
  const store = await liveStoreOf(deps, context, token);
  return store.ok ? ok({ slug: store.value.slug }) : store;
}

export interface JoinedStore {
  readonly slug: string;
  /** Whether the automatic follow of the store went through (the customer can still follow it). */
  readonly following: boolean;
}

/**
 * The signed-in customer claims an invite link (plan 7, "sign-up with seller link"). New sign-ups
 * only: an account attributed already, signed up longer ago than the Market's window, or with an
 * order is refused and nothing is recorded; a customer on the store's own team is recorded as
 * rejected (the admin sees it) and refused alike. Otherwise the attribution is recorded (flagged
 * `link-burst` when the link brought many customers in a day), its event drives the seller's
 * customers read model, and the store is followed for the customer (they can unfollow it).
 */
export async function joinStoreByInvitation(
  deps: InvitationDependencies,
  context: CallContext,
  input: { readonly token?: unknown },
): Promise<Result<JoinedStore, InvitationFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const rules = deps.invitationRules.rulesOf(context.market);
  if (rules === null) return err({ code: 'customers.unavailable' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) if (key !== 'token') return invalid(key, 'unknown');
  const token = normalizeInviteToken(input.token);
  if (token === null) return invalid('token', 'format');

  // Before any unit: the store must be public now, and the customer's own team membership is
  // asked of identity with the customer's own context (a boolean only).
  const store = await liveStoreOf(deps, context, token);
  if (!store.ok) return store;
  const { link, slug } = store.value;
  const tied = await deps.invitationPeers.identity.ownAccountTiedToSeller(context, link.sellerId);
  if (!tied.ok) return err({ code: 'customers.unavailable' });

  const { market } = context;
  const recorded = await deps.unitOfWork.run<AttributionStatus | 'refused', InvitationFailure>(
    market,
    async () => {
      // The link again, in the unit, and locked: a refresh that revoked it since is seen here, and
      // concurrent claims through it wait for each other, so the burst count below is exact.
      if (!(await deps.inviteLinks.lockLive(market, link.id))) {
        return err({ code: 'customers.invitation-not-found' });
      }
      const now = deps.clock.now();
      const signedUpAt = await deps.readModels.signedUpAtOf(market, accountId);
      // The directory copies a new account within seconds; until then the claim cannot be
      // recorded (the attribution row needs the directory row) and the storefront asks again.
      if (signedUpAt === null) return err({ code: 'customers.unavailable' });
      const [existing, stats, sellerLastDay] = await Promise.all([
        deps.attributions.findOf(market, accountId),
        deps.readModels.findStats(market, accountId),
        deps.attributions.countOfSellerSince(
          market,
          link.sellerId,
          now.subtract({ hours: DAY_HOURS }),
        ),
      ]);
      const decision = decideClaim(
        {
          now,
          signedUpAt,
          orderCount: stats?.orderCount ?? 0,
          attributed: existing !== null,
          sellerTeam: tied.value,
          sellerLastDay,
        },
        rules,
      );
      if (decision.kind === 'refuse') return ok('refused');
      const attribution: SellerAttribution = {
        accountId,
        sellerId: link.sellerId,
        linkId: link.id,
        attributedAt: now,
        status: decision.status,
        rejectReason: decision.rejectReason,
        flags: decision.flags,
        decidedByAccountId: null,
        decidedAt: null,
        version: 1,
      };
      if ((await deps.attributions.insert(market, attribution)) === 'exists') return ok('refused');
      await deps.outbox.append(context, [changedEvent(attribution)]);
      return ok(attribution.status);
    },
  );
  if (!recorded.ok) return recorded;
  if (recorded.value !== 'active') return err({ code: 'customers.invitation-not-eligible' });
  // After the commit, with the customer's own context: a refused or failed follow leaves the
  // attribution standing (the customer can follow the store themselves).
  const followed = await deps.invitationPeers.engagement
    .followStore(context, link.sellerId)
    .catch(() => null);
  return ok({ slug, following: followed !== null && followed.ok && followed.value.following });
}

const changedEvent = (attribution: SellerAttribution) =>
  SellerAttributionChangedEvent.record({
    aggregateId: attribution.accountId,
    aggregateVersion: attribution.version,
    occurredAt: attribution.decidedAt ?? attribution.attributedAt,
    payload: {
      accountId: attribution.accountId,
      sellerId: attribution.sellerId,
      status: attribution.status,
    },
  });

export interface OwnInvitationView {
  /** The store the customer joined through; null when none (or the attribution was rejected). */
  readonly store: {
    readonly sellerId: string;
    readonly slug: string | null;
    readonly joinedAt: string;
  } | null;
}

/**
 * The store the signed-in customer joined through, for the account's privacy line ("the store you
 * joined through sees your customer code and first name"). Only an active attribution is shown;
 * `slug` is null while the store is not public.
 */
export async function viewOwnInvitation(
  deps: InvitationDependencies,
  context: CallContext,
): Promise<Result<OwnInvitationView, InvitationFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.attributions.findOf(context.market, accountId)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'customers.unavailable' });
  const attribution = read.value;
  if (attribution === null || attribution.status !== 'active') return ok({ store: null });
  const slugs = await deps.invitationPeers.sellers.publishedStoreSlugs(context, [
    attribution.sellerId,
  ]);
  if (!slugs.ok) return err({ code: 'customers.unavailable' });
  return ok({
    store: {
      sellerId: attribution.sellerId,
      slug: slugs.value.get(attribution.sellerId) ?? null,
      joinedAt: attribution.attributedAt.toString(),
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Other modules (system): the exclusive seller of a customer

export interface ExclusiveSeller {
  readonly sellerId: Id<'Seller'>;
  readonly since: Temporal.Instant;
}

/**
 * The seller whose exclusive customer the account is at `at`: an active attribution recorded at or
 * before `at`. Null otherwise. For checkout (the order line's exclusive seller, phase 4b).
 */
export async function exclusiveSellerOf(
  deps: InvitationDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  at: Temporal.Instant,
): Promise<Result<ExclusiveSeller | null, InvitationFailure>> {
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.attributions.findOf(context.market, accountId)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'customers.unavailable' });
  const attribution = read.value;
  if (
    attribution === null ||
    attribution.status !== 'active' ||
    Temporal.Instant.compare(attribution.attributedAt, at) > 0
  ) {
    return ok(null);
  }
  return ok({ sellerId: attribution.sellerId, since: attribution.attributedAt });
}

// ---------------------------------------------------------------------------------------------
// The admin's list of attributions (a super list)

export const ATTRIBUTION_DEFAULT_PAGE_SIZE = 25;
export const ATTRIBUTION_MAX_PAGE_SIZE = 100;
/** Rows one select-all or one export may hold; more is refused whole. */
export const ATTRIBUTION_MAX_SELECTED = 10_000;

const FILTER_KEYS = [
  'sellerId',
  'status',
  'rejectReason',
  'flag',
  'attributedFrom',
  'attributedTo',
] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/** Reads `view`, `q` and `filters` of an admin request. Every other key is the caller's to refuse. */
export function attributionSelectorOf(
  input: Record<string, unknown>,
): Result<AttributionSelector, InvitationFailure> {
  let view: AttributionView = 'suspicious';
  if (present(input['view'])) {
    const found = ATTRIBUTION_VIEWS.find((candidate) => candidate === input['view']);
    if (found === undefined) return invalid('view', 'value');
    view = found;
  }
  let emailPrefix: string | null = null;
  if (present(input['q'])) {
    const q = input['q'];
    if (typeof q !== 'string') return invalid('q', 'type');
    const term = q.trim().toLowerCase();
    if (term.length < 2 || term.length > 254) return invalid('q', 'length');
    emailPrefix = term;
  }
  const selector = {
    view,
    emailPrefix,
    sellerId: null as Id<'Seller'> | null,
    status: null as AttributionSelector['status'],
    rejectReason: null as AttributionSelector['rejectReason'],
    flag: null as AttributionSelector['flag'],
    attributedFrom: null as string | null,
    attributedTo: null as string | null,
  };
  const filters = input['filters'];
  if (filters !== undefined && filters !== null) {
    if (!isRecord(filters)) return invalid('filters', 'type');
    for (const key of Object.keys(filters)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) {
        return invalid(`filters.${key}`, 'unknown');
      }
    }
    if (present(filters['sellerId'])) {
      const parsed =
        typeof filters['sellerId'] === 'string' ? parseId<'Seller'>(filters['sellerId']) : null;
      if (parsed === null || !parsed.ok) return invalid('filters.sellerId', 'format');
      selector.sellerId = parsed.value;
    }
    const pick = <T extends string>(key: string, values: readonly T[]): T | null | 'bad' => {
      if (!present(filters[key])) return null;
      const found = values.find((candidate) => candidate === filters[key]);
      return found ?? 'bad';
    };
    const status = pick('status', ATTRIBUTION_STATUSES);
    if (status === 'bad') return invalid('filters.status', 'value');
    selector.status = status;
    const reason = pick('rejectReason', ATTRIBUTION_REJECT_REASONS);
    if (reason === 'bad') return invalid('filters.rejectReason', 'value');
    selector.rejectReason = reason;
    const flag = pick('flag', ATTRIBUTION_FLAGS);
    if (flag === 'bad') return invalid('filters.flag', 'value');
    selector.flag = flag;
    for (const key of ['attributedFrom', 'attributedTo'] as const) {
      if (!present(filters[key])) continue;
      if (!isDay(filters[key])) return invalid(`filters.${key}`, 'format');
      selector[key] = filters[key];
    }
    if (
      selector.attributedFrom !== null &&
      selector.attributedTo !== null &&
      selector.attributedTo < selector.attributedFrom
    ) {
      return invalid('filters.attributedTo', 'range');
    }
  }
  return ok(selector);
}

const LIST_KEYS = new Set([
  'view',
  'q',
  'filters',
  'direction',
  'page',
  'pageSize',
  'cursor',
  'limit',
]);
const CURSOR = /^o(\d{1,5})$/;
const wholeNumber = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

export interface AttributionPageRequest {
  readonly selector: AttributionSelector;
  readonly direction: 'asc' | 'desc';
  readonly page: number | null;
  readonly offset: number;
  readonly limit: number;
}

/** Reads a list body: the selector, the direction (newest first by default), a page or a cursor. */
export function parseAttributionPage(
  input: unknown,
): Result<AttributionPageRequest, InvitationFailure> {
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) {
    if (!LIST_KEYS.has(key)) return invalid(key, 'unknown');
  }
  const selector = attributionSelectorOf(input);
  if (!selector.ok) return selector;
  let direction: 'asc' | 'desc' = 'desc';
  if (input['direction'] !== undefined) {
    if (input['direction'] !== 'asc' && input['direction'] !== 'desc') {
      return invalid('direction', 'value');
    }
    direction = input['direction'];
  }
  if (input['page'] !== undefined) {
    if (input['cursor'] !== undefined) return invalid('cursor', 'conflict');
    const page = wholeNumber(input['page'], 1, 1_000_000);
    if (page === null) return invalid('page', 'range');
    const size =
      input['pageSize'] === undefined
        ? ATTRIBUTION_DEFAULT_PAGE_SIZE
        : wholeNumber(input['pageSize'], 1, ATTRIBUTION_MAX_PAGE_SIZE);
    if (size === null) return invalid('pageSize', 'range');
    if ((page - 1) * size >= CUSTOMER_MAX_PAGED_ROWS) return invalid('page', 'range');
    return ok({
      selector: selector.value,
      direction,
      page,
      offset: (page - 1) * size,
      limit: size,
    });
  }
  if (input['pageSize'] !== undefined) return invalid('pageSize', 'needs-page');
  const limit =
    input['limit'] === undefined
      ? ATTRIBUTION_DEFAULT_PAGE_SIZE
      : wholeNumber(input['limit'], 1, ATTRIBUTION_MAX_PAGE_SIZE);
  if (limit === null) return invalid('limit', 'range');
  let offset = 0;
  if (input['cursor'] !== undefined) {
    const match = typeof input['cursor'] === 'string' ? CURSOR.exec(input['cursor']) : null;
    if (match === null) return invalid('cursor', 'format');
    offset = Number(match[1]);
    if (offset >= CUSTOMER_MAX_PAGED_ROWS) return invalid('cursor', 'range');
  }
  return ok({ selector: selector.value, direction, page: null, offset, limit });
}

/** A row of the admin list. */
export interface AttributionRowView {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly sellerId: string;
  readonly attributedAt: string;
  readonly status: AttributionStatus;
  readonly rejectReason: string | null;
  readonly flags: readonly string[];
  readonly decidedAt: string | null;
}

export function attributionRowView(record: AttributionListRecord): AttributionRowView {
  return {
    accountId: record.accountId,
    email: record.email,
    displayName: record.displayName,
    sellerId: record.sellerId,
    attributedAt: record.attributedAt.toString(),
    status: record.status,
    rejectReason: record.rejectReason,
    flags: [...record.flags],
    decidedAt: record.decidedAt === null ? null : record.decidedAt.toString(),
  };
}

export interface AttributionListOutput {
  readonly items: readonly AttributionRowView[];
  readonly counts: Readonly<Record<AttributionView, number>>;
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly maxRows: number;
  } | null;
  readonly nextCursor: string | null;
}

export async function listAttributions(
  deps: InvitationDependencies,
  context: CallContext,
  request: AttributionPageRequest,
): Promise<Result<AttributionListOutput, InvitationFailure>> {
  if (adminOfCall(context) === null) return err({ code: 'access.denied' });
  const { market } = context;
  const paged = request.page !== null;
  const read = await deps.unitOfWork.run(
    market,
    async () => {
      const [rows, counts, total] = await Promise.all([
        deps.attributions.page(market, request.selector, request.direction, {
          offset: request.offset,
          limit: paged ? request.limit : request.limit + 1,
        }),
        deps.attributions.viewCounts(market),
        paged ? deps.attributions.count(market, request.selector) : Promise.resolve(null),
      ]);
      return ok({ rows, counts, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'customers.unavailable' });
  const { rows, counts, total } = read.value;
  const more = !paged && rows.length > request.limit;
  const nextOffset = request.offset + request.limit;
  return ok({
    items: rows.slice(0, request.limit).map(attributionRowView),
    counts,
    paging:
      request.page === null || total === null
        ? null
        : { total, page: request.page, pageSize: request.limit, maxRows: CUSTOMER_MAX_PAGED_ROWS },
    nextCursor: more && nextOffset < CUSTOMER_MAX_PAGED_ROWS ? `o${nextOffset}` : null,
  });
}

/** Account ids one decision may name. */
export const MAX_DECISION_IDS = 100;

export interface DecisionOutcome {
  readonly accountId: string;
  readonly outcome: 'changed' | 'unchanged' | 'not-found' | 'seller-team';
  readonly status: AttributionStatus | null;
}

/**
 * An admin rejects attributions or restores them, one by one or in bulk (at most 100 accounts).
 * Each account's row is written only if no other decision moved it meanwhile (else the whole
 * request is refused and nothing is kept); a change is audited and sends its event (the seller's
 * customers read model follows). A restore of one rejected for the seller's team is
 * refused (`seller-team`).
 */
export async function decideAttributions(
  deps: InvitationDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<{ readonly results: readonly DecisionOutcome[] }, InvitationFailure>> {
  const admin = adminOfCall(context);
  if (admin === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) {
    if (key !== 'accountIds' && key !== 'decision') return invalid(key, 'unknown');
  }
  const decision = input['decision'];
  if (decision !== 'reject' && decision !== 'restore') return invalid('decision', 'value');
  const raw = input['accountIds'];
  if (!Array.isArray(raw) || raw.length === 0) return invalid('accountIds', 'required');
  if (raw.length > MAX_DECISION_IDS) return invalid('accountIds', 'too-many');
  const accountIds = new Set<Id<'Account'>>();
  for (const part of raw as unknown[]) {
    const parsed = typeof part === 'string' ? parseId<'Account'>(part) : null;
    if (parsed === null || !parsed.ok) return invalid('accountIds', 'format');
    accountIds.add(parsed.value);
  }
  const { market } = context;
  return deps.unitOfWork.run<{ readonly results: readonly DecisionOutcome[] }, InvitationFailure>(
    market,
    async () => {
      const now = deps.clock.now();
      const results: DecisionOutcome[] = [];
      for (const accountId of [...accountIds].sort()) {
        const current = await deps.attributions.findOf(market, accountId);
        if (current === null) {
          results.push({ accountId, outcome: 'not-found', status: null });
          continue;
        }
        const decided = decideAttribution(current, decision, admin, now);
        if (!decided.ok) {
          results.push({ accountId, outcome: 'seller-team', status: current.status });
          continue;
        }
        if (decided.value === 'unchanged') {
          results.push({ accountId, outcome: 'unchanged', status: current.status });
          continue;
        }
        const next = decided.value;
        // A concurrent decision on the same customer: nothing of this request is kept; ask again.
        if (!(await deps.attributions.update(market, next, current.version))) {
          return err({ code: 'customers.unavailable' });
        }
        await deps.audit.record(
          context,
          SellerAttributionDecided.entry(accountId, {
            before: { status: current.status },
            after: { status: next.status, sellerId: next.sellerId, version: next.version },
          }),
        );
        await deps.outbox.append(context, [changedEvent(next)]);
        results.push({ accountId, outcome: 'changed', status: next.status });
      }
      return ok({ results });
    },
  );
}
