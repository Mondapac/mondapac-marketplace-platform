import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { createFleetSelectionModel } from '../../src/modules/shipping/application/fleet-selection-flow';
import { SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP } from '../../src/modules/system-requests';
import { listRequests } from '../../src/modules/system-requests/application/list-flow';
import type { NewRequest } from '../../src/modules/system-requests/application/ports/request.repository';
import {
  approveRequest,
  rejectRequest,
  withdrawRequest,
} from '../../src/modules/system-requests/application/request-flow';
import { REVIEW_KEYS } from '../../src/modules/system-requests/application/review-keys';
import type { SystemRequestsDependencies } from '../../src/modules/system-requests/application/system-requests-dependencies';
import type { Risk } from '../../src/modules/system-requests/domain/areas';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import {
  accountOf,
  adminOf,
  editedModel,
  RULE,
  startHarness,
  type Harness,
} from './system-requests-harness';

// System requests decisions on their own (QA follow-ups of PR #904), on PostgreSQL with the real
// request store, audit writer and outbox, and shipping's real fleet-model hooks, in both Market
// fixtures:
// - a high-risk reject (or approval) without a fresh step-up proof is refused and leaves the
//   request open and the subject as it is;
// - a decision of one's own request is refused before any proof is spent (and before an applier
//   runs);
// - a reverter or an applier that throws after writing leaves nothing behind: the request is still
//   open, and there is no audit row, no outbox row and no change of the subject;
// - the queue read (a super list, CLAUDE.md rule 14): a cursor from another sort or direction is
//   refused, a page past the end is empty with the total, and every view's count follows the
//   filters. Its rows are new per test and filtered by their own author, so no other spec's
//   requests are counted.

describe.each(TEST_MARKETS)('system requests decisions in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(Temporal.Now.instant()));
  const admin = (name: string): CallContext => adminOf(market, ids, name);
  const unique = (label: string) => `${label} ${ids.next<'Account'>().slice(-8)}`;
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.faults.revert = false;
    h.faults.apply = false;
    h.stepUp.grant = true;
  });

  const requestRow = async (id: Id<'SystemRequest'>) =>
    (
      await h.sql.query<{ status: string; decision: string | null }>(
        'SELECT status, decision FROM system_requests.requests WHERE market_id = $1 AND id = $2',
        [market.marketId, id],
      )
    ).rows[0]!;
  const historyOf = async (id: Id<'SystemRequest'>) =>
    (
      await h.sql.query<{ kind: string }>(
        `SELECT kind FROM system_requests.request_activity
         WHERE market_id = $1 AND request_id = $2 ORDER BY at, kind`,
        [market.marketId, id],
      )
    ).rows.map((row) => row.kind);
  const auditActionsOf = async (targetId: string) =>
    (
      await h.sql.query<{ action: string }>(
        `SELECT action FROM platform.audit_log
         WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, action`,
        [market.marketId, targetId],
      )
    ).rows.map((row) => row.action);
  const outboxOf = async (id: Id<'SystemRequest'>) =>
    (
      await h.sql.query<{ one: number }>(
        `SELECT 1 AS one FROM system_requests.outbox WHERE market_id = $1 AND payload->>'requestId' = $2`,
        [market.marketId, id],
      )
    ).rows;
  const modelOf = async (modelId: string) =>
    (
      await h.sql.query<{ name: string; version: number }>(
        'SELECT name, version FROM shipping.fleet_selection_models WHERE market_id = $1 AND id = $2',
        [market.marketId, modelId],
      )
    ).rows[0]!;
  const modelsNamed = async (name: string) =>
    (
      await h.sql.query<{ one: number }>(
        `SELECT 1 AS one FROM shipping.fleet_selection_models
         WHERE market_id = $1 AND lower(name) = lower($2)`,
        [market.marketId, name],
      )
    ).rows;
  /** A proposal of a new model, at the given risk (the area's medium unless raised). */
  const proposal = async (author: CallContext, name: string, risk?: 'high') => {
    const proposer = h.shipping.proposer;
    const proposed = await createFleetSelectionModel(
      {
        ...h.shipping,
        proposer: {
          proposeChange: (context, change) =>
            proposer.proposeChange(context, risk === undefined ? change : { ...change, risk }),
        },
      },
      author,
      { name, rule: RULE, note: 'Drivers first' },
    );
    if (!proposed.ok || !('request' in proposed.value)) throw new Error('no proposal filed');
    return proposed.value.request.id;
  };

  describe('step-up and maker-checker', () => {
    it('refuses a high-risk reject without a fresh proof and keeps the request open', async () => {
      const edit = await editedModel(h, admin('sr-alone-author-1'), unique('High one'), {
        risk: 'high',
      });
      const { requestId } = edit;
      const reviewer = admin('sr-alone-reviewer-1');
      h.stepUp.grant = false;
      const refused = await rejectRequest(h.deps, reviewer, { requestId, reason: 'Not agreed' });
      expect(!refused.ok && refused.error).toEqual({
        code: 'second-factor.required',
        actionKey: SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP,
      });
      const approval = await approveRequest(h.deps, reviewer, { requestId });
      expect(!approval.ok && approval.error.code).toBe('second-factor.required');
      expect(await requestRow(requestId)).toEqual({ status: 'open', decision: null });
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });
      expect(await auditActionsOf(edit.modelId)).not.toContain('shipping.fleet-model.reverted');
      expect(await auditActionsOf(requestId)).toEqual(['system-requests.request.opened']);
      expect(await historyOf(requestId)).toEqual(['applied']);

      // With a fresh proof the same reject goes through: nothing was left half done.
      h.stepUp.grant = true;
      const rejected = await rejectRequest(h.deps, reviewer, { requestId, reason: 'Not agreed' });
      expect(rejected.ok).toBe(true);
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.before, version: 3 });
      expect(await requestRow(requestId)).toEqual({ status: 'reverted', decision: 'rejected' });
    });

    it('refuses the author deciding their own high-risk request before a proof is spent', async () => {
      const author = admin('sr-alone-author-2');
      const edit = await editedModel(h, author, unique('Own one'), { risk: 'high' });
      const { requestId } = edit;
      const spent = h.stepUp.spent;
      const approval = await approveRequest(h.deps, author, { requestId });
      const reject = await rejectRequest(h.deps, author, { requestId, reason: 'Mine' });
      expect(!approval.ok && approval.error.code).toBe('system-requests.own-request');
      expect(!reject.ok && reject.error.code).toBe('system-requests.own-request');
      expect(h.stepUp.spent).toBe(spent);
      expect(await requestRow(requestId)).toEqual({ status: 'open', decision: null });
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });

      // Its own high-risk proposal too: no proof spent and no model created.
      const name = unique('Own proposal');
      const proposed = await proposal(author, name, 'high');
      const own = await approveRequest(h.deps, author, { requestId: proposed });
      expect(!own.ok && own.error.code).toBe('system-requests.own-request');
      expect(h.stepUp.spent).toBe(spent);
      expect(await modelsNamed(name)).toEqual([]);
      expect(await requestRow(proposed)).toEqual({ status: 'open', decision: null });
    });
  });

  describe('a hook that throws after writing', () => {
    it('leaves the request open with no audit row, no outbox row and the subject unchanged (reverter)', async () => {
      const author = admin('sr-alone-author-3');
      const edit = await editedModel(h, author, unique('Throwing revert'));
      const { requestId } = edit;
      const auditBefore = await auditActionsOf(edit.modelId);
      h.faults.revert = true;
      await expect(
        rejectRequest(h.deps, admin('sr-alone-reviewer-3'), { requestId, reason: 'Not agreed' }),
      ).rejects.toThrow('test reverter failed after writing');
      expect(await requestRow(requestId)).toEqual({ status: 'open', decision: null });
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });
      expect(await auditActionsOf(edit.modelId)).toEqual(auditBefore);
      expect(await auditActionsOf(requestId)).toEqual(['system-requests.request.opened']);
      expect(await outboxOf(requestId)).toEqual([]);
      expect(await historyOf(requestId)).toEqual(['applied']);

      // The author's withdrawal runs the same reverter: nothing is written either.
      await expect(
        withdrawRequest(h.deps, author, { requestId, reason: 'Wrong model' }),
      ).rejects.toThrow('test reverter failed after writing');
      expect(await requestRow(requestId)).toEqual({ status: 'open', decision: null });
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });
      expect(await auditActionsOf(edit.modelId)).toEqual(auditBefore);
      expect(await auditActionsOf(requestId)).toEqual(['system-requests.request.opened']);
      expect(await outboxOf(requestId)).toEqual([]);
      expect(await historyOf(requestId)).toEqual(['applied']);

      // Working again, the reject goes through on the same request.
      h.faults.revert = false;
      const rejected = await rejectRequest(h.deps, admin('sr-alone-reviewer-3b'), {
        requestId,
        reason: 'Not agreed',
      });
      expect(rejected.ok).toBe(true);
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.before, version: 3 });
    });

    it('leaves the proposal open with no model, no audit row and no outbox row (applier)', async () => {
      const name = unique('Throwing apply');
      const requestId = await proposal(admin('sr-alone-author-4'), name);
      h.faults.apply = true;
      await expect(
        approveRequest(h.deps, admin('sr-alone-reviewer-4'), { requestId }),
      ).rejects.toThrow('test applier failed after writing');
      expect(await requestRow(requestId)).toEqual({ status: 'open', decision: null });
      expect(await modelsNamed(name)).toEqual([]);
      expect(await auditActionsOf(requestId)).toEqual(['system-requests.request.opened']);
      const created = await h.sql.query(
        `SELECT 1 FROM platform.audit_log WHERE market_id = $1
           AND action = 'shipping.fleet-model.created' AND after->>'requestId' = $2`,
        [market.marketId, requestId],
      );
      expect(created.rows).toEqual([]);
      expect(await outboxOf(requestId)).toEqual([]);
      expect(await historyOf(requestId)).toEqual(['proposed']);

      h.faults.apply = false;
      const approved = await approveRequest(h.deps, admin('sr-alone-reviewer-4b'), { requestId });
      expect(approved.ok).toBe(true);
      expect(await modelsNamed(name)).toHaveLength(1);
    });
  });

  describe('the queue read (super list)', () => {
    const base = Temporal.Now.instant().subtract({ hours: 30 * 24 });
    /**
     * Six requests of one new author, an hour apart: two delivery (one high), four catalogue;
     * two approved and one rejected by `decider`; the first open one overdue.
     */
    const seed = async (author: Id<'Account'>, decider: Id<'Account'>, marker: string) => {
      const plan: readonly {
        area: 'delivery' | 'catalogue';
        risk: Risk;
        decided?: 'approved' | 'rejected';
        overdue?: true;
      }[] = [
        { area: 'delivery', risk: 'high', overdue: true },
        { area: 'catalogue', risk: 'low', decided: 'approved' },
        { area: 'catalogue', risk: 'high' },
        { area: 'delivery', risk: 'low', decided: 'rejected' },
        { area: 'catalogue', risk: 'medium', decided: 'approved' },
        { area: 'catalogue', risk: 'low' },
      ];
      // These rows stay in the run's throwaway database, open and overdue ones included.
      const made: NewRequest[] = [];
      for (const [n, item] of plan.entries()) {
        const appliedAt = base.add({ hours: n });
        const request: NewRequest = {
          id: ids.next<'SystemRequest'>(),
          area: item.area,
          subjectKind: 'settings.market-setting',
          subjectRef: `list-${randomUUID()}`,
          mode: 'review',
          risk: item.risk,
          before: { size: n },
          after: { size: n + 1 },
          note: `queue ${marker} ${n}`,
          requestedBy: author,
          appliedAt,
          // The overdue one is due already; the others in a year, so the order by due date is
          // the order by number but for the first.
          reviewDueAt: item.overdue
            ? appliedAt.add({ hours: 1 })
            : appliedAt.add({ hours: 365 * 24 }),
        };
        const decision = item.decided;
        const result = await h.deps.unitOfWork.run(market, async () => {
          await h.requests.open(market, request, ids.next<'SystemRequestActivity'>());
          if (decision !== undefined) {
            await h.requests.decide(market, request.id, {
              status: decision === 'approved' ? 'approved' : 'reverted',
              decision,
              decidedBy: decider,
              decidedAt: appliedAt.add({ minutes: 5 }),
              reason: decision === 'approved' ? null : 'No',
            });
          }
          return ok(undefined);
        });
        if (!result.ok) throw new Error('seed failed');
        made.push(request);
      }
      return made;
    };
    /** The deps of a viewer who reviews only `areas` (the review keys asked of the check). */
    const reviewing = (areas: readonly string[]): SystemRequestsDependencies => ({
      ...h.deps,
      authorisation: {
        check: (_context, declaration) => {
          const rule = declaration.rule as { allOf?: readonly string[] };
          const keys = new Set(areas.map((area) => REVIEW_KEYS[area as keyof typeof REVIEW_KEYS]));
          return Promise.resolve(
            (rule.allOf ?? []).every((key) => keys.has(key as never))
              ? ({ allowed: true } as const)
              : ({ allowed: false, denial: { code: 'access.denied' } } as const),
          );
        },
      },
    });

    it('refuses a cursor of another sort or direction and walks its own to the end', async () => {
      const author = admin('sr-list-author-1');
      const viewer = admin('sr-list-viewer-1');
      const made = await seed(accountOf(author), accountOf(viewer), randomUUID().slice(0, 8));
      const filter = { view: 'all', requestedBy: accountOf(author), pageSize: '2' };
      const first = await listRequests(h.deps, viewer, { ...filter, sort: 'applied' });
      if (!first.ok) throw new Error(first.error.code);
      expect(first.value.total).toBeNull();
      const cursor = first.value.nextCursor;
      expect(cursor).not.toBeNull();
      for (const changed of [
        { sort: 'number' },
        { sort: 'due' },
        { sort: 'applied', direction: 'desc' },
      ]) {
        expect(await listRequests(h.deps, viewer, { ...filter, ...changed, cursor })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'cursor', code: 'format' }] },
        });
      }
      expect(
        await listRequests(h.deps, viewer, { ...filter, sort: 'applied', cursor, page: '2' }),
      ).toMatchObject({ ok: false, error: { fields: [{ path: 'cursor', code: 'with-page' }] } });

      // Its own sort walks every row once; six rows in pages of two end without an empty page.
      const seen: string[] = [...first.value.rows.map((row) => row.id)];
      let next: string | null = cursor;
      let pages = 1;
      while (next !== null) {
        const page = await listRequests(h.deps, viewer, {
          ...filter,
          sort: 'applied',
          cursor: next,
        });
        if (!page.ok) throw new Error(page.error.code);
        expect(page.value.rows.length).toBeGreaterThan(0);
        seen.push(...page.value.rows.map((row) => row.id));
        next = page.value.nextCursor;
        pages += 1;
      }
      expect(pages).toBe(3);
      expect(seen).toEqual(made.map((request) => request.id));

      // By due date, descending: the overdue one (due first) comes last.
      const byDue: string[] = [];
      let dueCursor: string | null | undefined;
      do {
        const page = await listRequests(h.deps, viewer, {
          ...filter,
          sort: 'due',
          direction: 'desc',
          ...(dueCursor ? { cursor: dueCursor } : {}),
        });
        if (!page.ok) throw new Error(page.error.code);
        byDue.push(...page.value.rows.map((row) => row.id));
        dueCursor = page.value.nextCursor;
      } while (dueCursor !== null);
      expect(byDue).toEqual([...made.slice(1).reverse(), made[0]!].map((request) => request.id));
    });

    it('answers a page past the end with no rows and the total', async () => {
      const author = admin('sr-list-author-2');
      const viewer = admin('sr-list-viewer-2');
      const made = await seed(accountOf(author), accountOf(viewer), randomUUID().slice(0, 8));
      const filter = { view: 'all', requestedBy: accountOf(author), pageSize: '4', sort: 'number' };
      const second = await listRequests(h.deps, viewer, { ...filter, page: '2' });
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value).toMatchObject({ total: 6, page: 2, pageSize: 4, nextCursor: null });
      expect(second.value.rows.map((row) => row.id)).toEqual(made.slice(4).map((r) => r.id));
      for (const page of ['3', '250']) {
        const past = await listRequests(h.deps, viewer, { ...filter, page });
        if (!past.ok) throw new Error(past.error.code);
        expect(past.value).toMatchObject({
          rows: [],
          total: 6,
          page: Number(page),
          nextCursor: null,
        });
        expect(past.value.counts.all).toBe(6);
      }
      // A filter that matches nothing: page 1 is empty, with a total of 0.
      const none = await listRequests(h.deps, viewer, {
        ...filter,
        page: '1',
        risk: 'medium',
        status: 'open',
      });
      expect(none.ok && none.value).toMatchObject({ rows: [], total: 0 });
    });

    it('counts every view under the same filters', async () => {
      const author = admin('sr-list-author-3');
      const viewer = admin('sr-list-viewer-3');
      const marker = randomUUID().slice(0, 8);
      await seed(accountOf(author), accountOf(viewer), marker);
      const countsOf = async (
        deps: SystemRequestsDependencies,
        context: CallContext,
        input: Record<string, string>,
      ) => {
        const answer = await listRequests(deps, context, {
          view: 'all',
          requestedBy: accountOf(author),
          ...input,
        });
        if (!answer.ok) throw new Error(answer.error.code);
        return answer.value.counts;
      };
      const all = {
        'needs-my-review': 3,
        'all-open': 3,
        mine: 0,
        approved: 2,
        reverted: 1,
        overdue: 1,
        all: 6,
      };
      expect(await countsOf(h.deps, viewer, {})).toEqual(all);
      // The author sees the same rows as theirs, and none to review.
      expect(await countsOf(h.deps, author, {})).toEqual({ ...all, 'needs-my-review': 0, mine: 6 });
      expect(await countsOf(h.deps, viewer, { risk: 'high' })).toEqual({
        'needs-my-review': 2,
        'all-open': 2,
        mine: 0,
        approved: 0,
        reverted: 0,
        overdue: 1,
        all: 2,
      });
      expect(
        await countsOf(h.deps, viewer, { area: 'catalogue', status: 'approved,open' }),
      ).toEqual({
        'needs-my-review': 2,
        'all-open': 2,
        mine: 0,
        approved: 2,
        reverted: 0,
        overdue: 0,
        all: 4,
      });
      expect(await countsOf(h.deps, viewer, { decidedBy: accountOf(viewer) })).toEqual({
        'needs-my-review': 0,
        'all-open': 0,
        mine: 0,
        approved: 2,
        reverted: 1,
        overdue: 0,
        all: 3,
      });
      expect(await countsOf(h.deps, viewer, { overdue: 'true' })).toMatchObject({
        'all-open': 1,
        overdue: 1,
        all: 1,
        approved: 0,
      });
      expect(
        await countsOf(h.deps, viewer, { q: `QUEUE ${marker.toUpperCase()} 2` }),
      ).toMatchObject({
        all: 1,
        'all-open': 1,
      });
      // A viewer who reviews delivery only: Needs my review holds the one open delivery request,
      // and nothing once the filter asks for catalogue; the other views do not depend on it.
      const delivery = reviewing(['delivery']);
      expect(await countsOf(delivery, viewer, {})).toEqual({ ...all, 'needs-my-review': 1 });
      expect(await countsOf(delivery, viewer, { area: 'catalogue' })).toEqual({
        'needs-my-review': 0,
        'all-open': 2,
        mine: 0,
        approved: 2,
        reverted: 0,
        overdue: 0,
        all: 4,
      });
      // In page mode the total is the view's count.
      const page = await listRequests(h.deps, viewer, {
        view: 'approved',
        requestedBy: accountOf(author),
        page: '1',
      });
      expect(page.ok && page.value.total).toBe(2);
    });
  });
});
