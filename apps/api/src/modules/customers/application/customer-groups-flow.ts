import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  CustomerGroupChanged,
  CustomerGroupCreated,
  CustomerGroupMembersChanged,
} from '../domain/audit';
import {
  GROUP_BULK_IDS_MAX,
  GROUP_BULK_MATCHING_MAX,
  GROUPS_PER_MARKET_MAX,
  parseGroupDescription,
  parseGroupName,
  type CustomerGroup,
  type CustomerGroupWithCount,
} from '../domain/customer-groups';
import type { TimelineEntry } from '../domain/customer-timeline';
import type { CustomerManagementDependencies } from './customer-management-dependencies';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  selectorOfRequest,
  type ListValidationFailure,
} from './customer-list-flow';

// The admin's manual customer groups (phase 2, PR 2a). Plain functions: use cases cannot extend
// one another. Every write is audited (ids and codes only) and runs in one unit; the members of a
// bulk change get a timeline entry each, in the same unit.

export type GroupFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'customers.group-not-found' }
  | { readonly code: 'customers.group-name-taken' }
  | { readonly code: 'customers.group-limit-reached'; readonly max: number }
  | { readonly code: 'customers.group-archived' }
  | { readonly code: 'customers.conflict' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ListValidationFailure;

/** A group as the admin pages show it. */
export interface CustomerGroupView {
  readonly groupId: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: 'manual';
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly memberCount: number;
  readonly createdByAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export const groupView = (group: CustomerGroupWithCount): CustomerGroupView => ({
  groupId: group.id,
  name: group.name,
  description: group.description,
  kind: group.kind,
  archived: group.archivedAt !== null,
  archivedAt: group.archivedAt === null ? null : group.archivedAt.toString(),
  memberCount: group.memberCount,
  createdByAccountId: group.createdByAccountId,
  createdAt: group.createdAt.toString(),
  updatedAt: group.updatedAt.toString(),
  version: group.version,
});

/** A group id from a request: text that is no id is the same `group-not-found`. */
export function groupIdOf(value: unknown): Id<'CustomerGroup'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'CustomerGroup'>(value);
  return parsed !== null && parsed.ok ? parsed.value : null;
}

function closed(
  input: unknown,
  keys: readonly string[],
): Result<Record<string, unknown>, ListValidationFailure> {
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) return invalidField(key, 'unknown');
  }
  return ok(input);
}

/** Every group of the Market, live ones first, with its member count. */
export async function listGroups(
  deps: CustomerManagementDependencies,
  context: CallContext,
): Promise<Result<{ readonly items: readonly CustomerGroupView[] }, GroupFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.groups.list(context.market)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({ items: read.value.map(groupView) });
}

/** One group, for the members page's header. */
export async function viewGroup(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerGroupView, GroupFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const body = closed(input, ['groupId']);
  if (!body.ok) return body;
  const groupId = groupIdOf(body.value['groupId']);
  if (groupId === null) return err({ code: 'customers.group-not-found' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.groups.find(context.market, groupId)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return read.value === null
    ? err({ code: 'customers.group-not-found' })
    : ok(groupView(read.value));
}

/** Makes a manual group: a name (one per Market, whatever its case) and an optional description. */
export async function createGroup(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerGroupView, GroupFailure>> {
  const admin = adminAccountOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const body = closed(input, ['name', 'description']);
  if (!body.ok) return body;
  const name = parseGroupName(body.value['name']);
  if (!name.ok) return invalidField(name.error.path, name.error.code);
  const description = parseGroupDescription(body.value['description']);
  if (!description.ok) return invalidField(description.error.path, description.error.code);
  const now = deps.clock.now();
  const group: CustomerGroup = {
    id: deps.ids.next<'CustomerGroup'>(),
    name: name.value,
    description: description.value,
    kind: 'manual',
    archivedAt: null,
    createdByAccountId: admin,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  return deps.unitOfWork.run<CustomerGroupView, GroupFailure>(
    context.market,
    async () => {
      if ((await deps.groups.count(context.market)) >= GROUPS_PER_MARKET_MAX) {
        return err({ code: 'customers.group-limit-reached', max: GROUPS_PER_MARKET_MAX });
      }
      if ((await deps.groups.insert(context.market, group)) === 'name-taken') {
        return err({ code: 'customers.group-name-taken' });
      }
      await deps.audit.record(
        context,
        CustomerGroupCreated.entry(group.id, { after: { kind: 'manual', version: 1 } }),
      );
      return ok(groupView({ ...group, memberCount: 0 }));
    },
    // The count and the insert are one decision: two admins at the limit do not both pass.
    { isolation: 'serializable' },
  );
}

/**
 * Renames, describes, archives or restores a group under the version the admin saw
 * (`expectedVersion`; a stale one is `customers.conflict`). Only the fields given change; the same
 * values again change nothing and write no row.
 */
export async function updateGroup(
  deps: CustomerManagementDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerGroupView, GroupFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const body = closed(input, ['groupId', 'expectedVersion', 'name', 'description', 'archived']);
  if (!body.ok) return body;
  const groupId = groupIdOf(body.value['groupId']);
  if (groupId === null) return err({ code: 'customers.group-not-found' });
  const expected = body.value['expectedVersion'];
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
    return invalidField('expectedVersion', 'range');
  }
  let name: string | null = null;
  if (body.value['name'] !== undefined) {
    const parsed = parseGroupName(body.value['name']);
    if (!parsed.ok) return invalidField(parsed.error.path, parsed.error.code);
    name = parsed.value;
  }
  let description: { readonly value: string | null } | null = null;
  if (body.value['description'] !== undefined) {
    const parsed = parseGroupDescription(body.value['description']);
    if (!parsed.ok) return invalidField(parsed.error.path, parsed.error.code);
    description = { value: parsed.value };
  }
  const archived = body.value['archived'];
  if (archived !== undefined && typeof archived !== 'boolean') {
    return invalidField('archived', 'type');
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<CustomerGroupView, GroupFailure>(context.market, async () => {
    const group = await deps.groups.find(context.market, groupId);
    if (group === null) return err({ code: 'customers.group-not-found' });
    if (group.version !== expected) return err({ code: 'customers.conflict' });
    const nextName = name ?? group.name;
    const nextDescription = description === null ? group.description : description.value;
    const wasArchived = group.archivedAt !== null;
    const nextArchivedAt =
      archived === undefined || archived === wasArchived ? group.archivedAt : archived ? now : null;
    const renamed = nextName !== group.name;
    const describedChanged = nextDescription !== group.description;
    if (!renamed && !describedChanged && nextArchivedAt === group.archivedAt) {
      return ok(groupView(group));
    }
    const written = await deps.groups.update(context.market, {
      id: groupId,
      expectedVersion: expected,
      name: nextName,
      description: nextDescription,
      archivedAt: nextArchivedAt,
      updatedAt: now,
    });
    if (written === 'stale') return err({ code: 'customers.conflict' });
    if (written === 'name-taken') return err({ code: 'customers.group-name-taken' });
    await deps.audit.record(
      context,
      CustomerGroupChanged.entry(groupId, {
        before: { version: group.version, archived: wasArchived },
        after: {
          version: group.version + 1,
          archived: nextArchivedAt !== null,
          renamed,
          describedChanged,
        },
      }),
    );
    return ok(
      groupView({
        ...group,
        name: nextName,
        description: nextDescription,
        archivedAt: nextArchivedAt,
        updatedAt: now,
        version: group.version + 1,
      }),
    );
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function namedIds(
  value: unknown,
): Result<
  readonly Id<'Account'>[],
  ListValidationFailure | { code: 'batch.too-large'; max: number }
> {
  if (!Array.isArray(value)) return invalidField('ids', 'type');
  if (value.length === 0) return invalidField('ids', 'required');
  if (value.length > GROUP_BULK_IDS_MAX)
    return err({ code: 'batch.too-large', max: GROUP_BULK_IDS_MAX });
  const out = new Set<string>();
  for (const part of value as unknown[]) {
    if (typeof part !== 'string' || !UUID.test(part)) return invalidField('ids', 'format');
    out.add(part);
  }
  return ok([...out] as Id<'Account'>[]);
}

export interface MembersChangeOutput {
  /** The customers the call added or removed (already-members and non-members are skipped). */
  readonly changed: number;
  /** The customers the call named or matched. */
  readonly requested: number;
}

/**
 * Adds customers to a group, or removes them: by `ids` (at most 1000, the page's selection) or by
 * the Customers list's `view`, `q` and `filters` ("select all matching", at most 10,000; more is
 * refused whole with the total). An archived group takes no new members. An id that is no
 * customer of the Market is skipped. One unit: the change, the audit row (how many, and how they
 * were picked) and a timeline entry for each customer changed.
 */
export async function changeMembers(
  deps: CustomerManagementDependencies,
  context: CallContext,
  change: 'add' | 'remove',
  input: unknown,
): Promise<Result<MembersChangeOutput, GroupFailure>> {
  const admin = adminAccountOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const body = closed(input, ['groupId', 'ids', 'view', 'q', 'filters']);
  if (!body.ok) return body;
  const groupId = groupIdOf(body.value['groupId']);
  if (groupId === null) return err({ code: 'customers.group-not-found' });
  const byIds = body.value['ids'] !== undefined;
  if (byIds && ['view', 'q', 'filters'].some((key) => body.value[key] !== undefined)) {
    return invalidField('ids', 'conflict');
  }
  let named: readonly Id<'Account'>[] | null = null;
  if (byIds) {
    const parsed = namedIds(body.value['ids']);
    if (!parsed.ok) return parsed;
    named = parsed.value;
  }
  const selector = selectorOfRequest(body.value);
  if (!selector.ok) return selector;
  const now = deps.clock.now();
  const { market } = context;

  return deps.unitOfWork.run<MembersChangeOutput, GroupFailure>(market, async () => {
    const group = await deps.groups.find(market, groupId);
    if (group === null) return err({ code: 'customers.group-not-found' });
    if (change === 'add' && group.archivedAt !== null)
      return err({ code: 'customers.group-archived' });
    let ids: readonly Id<'Account'>[];
    if (named !== null) {
      ids = named;
    } else {
      const query = { selector: selector.value, now };
      ids = await deps.listReader.ids(market, query, GROUP_BULK_MATCHING_MAX + 1);
      if (ids.length > GROUP_BULK_MATCHING_MAX) {
        const total = await deps.listReader.count(market, query);
        return err({ code: 'batch.too-large', max: GROUP_BULK_MATCHING_MAX, total });
      }
    }
    const changed =
      change === 'add'
        ? await deps.groups.addMembers(market, groupId, ids, admin, now)
        : await deps.groups.removeMembers(market, groupId, ids);
    if (changed.length > 0) {
      await deps.audit.record(
        context,
        CustomerGroupMembersChanged.entry(groupId, {
          after: {
            change: change === 'add' ? 'added' : 'removed',
            count: changed.length,
            selection: named !== null ? 'ids' : 'filter',
          },
        }),
      );
      const entries: TimelineEntry[] = changed.map((accountId) => ({
        id: deps.ids.next<'CustomerTimelineEntry'>(),
        accountId,
        occurredAt: now,
        kind: change === 'add' ? 'group-added' : 'group-removed',
        ref: { type: 'group', id: groupId },
        actorAccountId: admin,
        detail: null,
        sourceEventId: null,
      }));
      await deps.timeline.recordMany(market, entries, now);
    }
    return ok({ changed: changed.length, requested: ids.length });
  });
}
