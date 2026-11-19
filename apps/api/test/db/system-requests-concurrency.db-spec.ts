import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  createFleetSelectionModel,
  updateFleetSelectionModel,
} from '../../src/modules/shipping/application/fleet-selection-flow';
import { fleetModelNameRef } from '../../src/modules/shipping/application/shipping-review';
import {
  approveRequest,
  rejectRequest,
  withdrawRequest,
  type RequestView,
  type SystemRequestsFailure,
} from '../../src/modules/system-requests/application/request-flow';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import type { Result } from '@mondapac/shared-kernel';
import { TEST_MARKETS } from '../support/test-config';
import {
  adminOf,
  COUNTER_ROW_LOCK,
  editedModel,
  REQUEST_ROW_LOCK,
  RULE,
  startHarness,
  whileLocked,
  type Harness,
} from './system-requests-harness';
import { marketOf } from './persistence-support';

// System requests under concurrency (QA follow-ups of PR #904, and the approval mode of 18 Nov
// 2026), on PostgreSQL with the real request store, the real audit writer and shipping's real
// fleet-model hooks, in both Market fixtures. Each race starts its two calls together while the
// test holds the row lock the calls take first (the request's row for a decision, the Market's
// counter for a proposal) and lets go once both wait behind it, so they really meet; the checks
// hold whichever call wins:
// - two reviewers deciding one request: one wins, the other is `system-requests.decided`; the
//   revert runs at most once; one history line and one audit row per decision;
// - an approval racing the author's withdrawal: one wins, the state is the winner's;
// - a reject racing a new change of the subject by its module: the newer value is never
//   overwritten (the reject answers changed-since, or the change is refused as stale);
// - approval mode: two proposals of one subject give one request and one `already-pending`; two
//   approvals of one proposal apply it once; an approval racing a withdrawal.

type Answer = Result<RequestView, SystemRequestsFailure>;
const codeOf = (answer: Answer) => (answer.ok ? 'ok' : answer.error.code);

describe.each(TEST_MARKETS)('system requests under concurrency in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(Temporal.Now.instant()));
  const admin = (name: string): CallContext => adminOf(market, ids, name);
  const unique = (label: string) => `${label} ${ids.next<'Account'>().slice(-8)}`;
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    // The counter row the proposal race locks exists once the Market opened a request.
    await h.owner.query(
      `INSERT INTO system_requests.request_counters (market_id, tenant_id, last_number)
       VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`,
      [market.marketId, market.tenantId],
    );
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
      await h.sql.query<{
        status: string;
        decision: string | null;
        decided_by_account_id: string | null;
        superseded_by_request_id: string | null;
      }>(
        `SELECT status, decision, decided_by_account_id, superseded_by_request_id
         FROM system_requests.requests WHERE market_id = $1 AND id = $2`,
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
  /** The audit actions of a target (a request or a model), oldest first. */
  const auditOf = async (targetId: string) =>
    (
      await h.sql.query<{ action: string; after: { requestId?: string } | null }>(
        `SELECT action, after FROM platform.audit_log
         WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, action`,
        [market.marketId, targetId],
      )
    ).rows;
  const decisionsAudited = async (id: Id<'SystemRequest'>) =>
    (await auditOf(id))
      .map((row) => row.action)
      .filter((action) => action !== 'system-requests.request.opened');
  const modelOf = async (modelId: string) =>
    (
      await h.sql.query<{ name: string; version: number }>(
        'SELECT name, version FROM shipping.fleet_selection_models WHERE market_id = $1 AND id = $2',
        [market.marketId, modelId],
      )
    ).rows[0]!;
  const modelsNamed = async (name: string) =>
    (
      await h.sql.query<{ id: string }>(
        `SELECT id FROM shipping.fleet_selection_models
         WHERE market_id = $1 AND lower(name) = lower($2)`,
        [market.marketId, name],
      )
    ).rows;
  const atOnce = <A, B>(
    lockSql: string,
    params: readonly unknown[],
    a: () => Promise<A>,
    b: () => Promise<B>,
  ) => whileLocked(h.owner, h.sql, lockSql, params, 2, () => Promise.all([a(), b()]));
  const onRequest = (id: Id<'SystemRequest'>) => [market.marketId, id] as const;

  describe('two reviewers decide one request at once', () => {
    it('approve against reject: one wins, the revert runs at most once', async () => {
      const author = admin('sr-race-author-1');
      const approver = admin('sr-race-approver-1');
      const rejecter = admin('sr-race-rejecter-1');
      const edit = await editedModel(h, author, unique('Race one'));
      const { requestId } = edit;
      const [approved, rejected] = await atOnce(
        REQUEST_ROW_LOCK,
        onRequest(requestId),
        () => approveRequest(h.deps, approver, { requestId }),
        () => rejectRequest(h.deps, rejecter, { requestId, reason: 'Not agreed' }),
      );
      expect([codeOf(approved), codeOf(rejected)].sort()).toEqual([
        'ok',
        'system-requests.decided',
      ]);
      const row = await requestRow(requestId);
      const modelAudit = (await auditOf(edit.modelId)).map((line) => line.action);
      if (approved.ok) {
        expect(row).toMatchObject({ status: 'approved', decision: 'approved' });
        expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });
        expect(modelAudit).not.toContain('shipping.fleet-model.reverted');
        expect(await historyOf(requestId)).toEqual(['applied', 'approved']);
        expect(await decisionsAudited(requestId)).toEqual(['system-requests.request.approved']);
      } else {
        expect(row).toMatchObject({ status: 'reverted', decision: 'rejected' });
        expect(await modelOf(edit.modelId)).toEqual({ name: edit.before, version: 3 });
        expect(modelAudit.filter((a) => a === 'shipping.fleet-model.reverted')).toHaveLength(1);
        expect(await historyOf(requestId)).toEqual(['applied', 'rejected']);
        expect(await decisionsAudited(requestId)).toEqual(['system-requests.request.reverted']);
      }
    });

    it('approve against approve: one approval, one history line, one audit row', async () => {
      const author = admin('sr-race-author-2');
      const first = admin('sr-race-approver-2a');
      const second = admin('sr-race-approver-2b');
      const edit = await editedModel(h, author, unique('Race two'));
      const { requestId } = edit;
      const answers = await atOnce(
        REQUEST_ROW_LOCK,
        onRequest(requestId),
        () => approveRequest(h.deps, first, { requestId }),
        () => approveRequest(h.deps, second, { requestId }),
      );
      expect(answers.map(codeOf).sort()).toEqual(['ok', 'system-requests.decided']);
      const winner = answers[0].ok ? first : second;
      expect(await requestRow(requestId)).toMatchObject({
        status: 'approved',
        decided_by_account_id: (winner.actor as { accountId: string }).accountId,
      });
      expect(await historyOf(requestId)).toEqual(['applied', 'approved']);
      expect(await decisionsAudited(requestId)).toEqual(['system-requests.request.approved']);
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });
    });
  });

  it('approve racing the author withdrawing: one wins and the state is the winner’s', async () => {
    const author = admin('sr-race-author-3');
    const approver = admin('sr-race-approver-3');
    const edit = await editedModel(h, author, unique('Race three'));
    const { requestId } = edit;
    const [approved, withdrawn] = await atOnce(
      REQUEST_ROW_LOCK,
      onRequest(requestId),
      () => approveRequest(h.deps, approver, { requestId }),
      () => withdrawRequest(h.deps, author, { requestId, reason: 'Wrong model' }),
    );
    expect([codeOf(approved), codeOf(withdrawn)].sort()).toEqual(['ok', 'system-requests.decided']);
    const modelAudit = (await auditOf(edit.modelId)).map((line) => line.action);
    if (approved.ok) {
      expect(await requestRow(requestId)).toMatchObject({ status: 'approved' });
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.after, version: 2 });
      expect(modelAudit).not.toContain('shipping.fleet-model.reverted');
      expect(await historyOf(requestId)).toEqual(['applied', 'approved']);
    } else {
      expect(await requestRow(requestId)).toMatchObject({
        status: 'reverted',
        decision: 'withdrawn',
      });
      expect(await modelOf(edit.modelId)).toEqual({ name: edit.before, version: 3 });
      expect(modelAudit.filter((a) => a === 'shipping.fleet-model.reverted')).toHaveLength(1);
      expect(await historyOf(requestId)).toEqual(['applied', 'withdrawn']);
    }
    expect(await decisionsAudited(requestId)).toHaveLength(1);
  });

  it('reject racing a new change of the subject never overwrites the newer value', async () => {
    const author = admin('sr-race-author-4');
    const rejecter = admin('sr-race-rejecter-4');
    const editor = admin('sr-race-editor-4');
    const edit = await editedModel(h, author, unique('Race four'));
    const { requestId } = edit;
    const newer = `${edit.before} newer`;
    const [rejected, changed] = await atOnce(
      REQUEST_ROW_LOCK,
      onRequest(requestId),
      () => rejectRequest(h.deps, rejecter, { requestId, reason: 'Not agreed' }),
      () =>
        updateFleetSelectionModel(h.shipping, editor, {
          modelId: edit.modelId,
          name: newer,
          rule: { kind: 'cheapest' },
          expectedVersion: 2,
          note: 'A newer change',
        }),
    );
    const model = await modelOf(edit.modelId);
    const modelAudit = (await auditOf(edit.modelId)).map((line) => line.action);
    if (changed.ok) {
      // The new change won: it is live, it superseded the request, and the reject restored nothing.
      expect(changed.value.request).not.toBeNull();
      const newerId = changed.value.request!.id;
      expect(model).toEqual({ name: newer, version: 3 });
      expect(!rejected.ok && rejected.error.code).toBe('system-requests.changed-since');
      const named =
        !rejected.ok && 'newerRequestId' in rejected.error && rejected.error.newerRequestId;
      expect([null, newerId]).toContain(named);
      expect(await requestRow(requestId)).toMatchObject({
        status: 'open',
        superseded_by_request_id: newerId,
      });
      expect(modelAudit).not.toContain('shipping.fleet-model.reverted');
      expect(await historyOf(requestId)).toEqual(['applied']);
      expect(await decisionsAudited(requestId)).toEqual([]);
    } else {
      // The reject won: the value before is back, and the change, made from a stale version, was
      // refused with nothing written.
      expect(changed.error.code).toBe('shipping.fleet-model-conflict');
      expect(rejected.ok).toBe(true);
      expect(model).toEqual({ name: edit.before, version: 3 });
      expect(await requestRow(requestId)).toMatchObject({
        status: 'reverted',
        decision: 'rejected',
        superseded_by_request_id: null,
      });
      expect(modelAudit.filter((a) => a === 'shipping.fleet-model.reverted')).toHaveLength(1);
      expect(await historyOf(requestId)).toEqual(['applied', 'rejected']);
      const later = await h.sql.query(
        `SELECT 1 FROM system_requests.requests
         WHERE market_id = $1 AND subject_ref = $2 AND id <> $3`,
        [market.marketId, edit.modelId, requestId],
      );
      expect(later.rows).toEqual([]);
    }
    expect(model.name).not.toBe(edit.after);
  });

  describe('approval mode', () => {
    it('files one of two proposals of a subject made at once; the other is already-pending', async () => {
      const name = unique('Twin model');
      const [one, two] = await atOnce(
        COUNTER_ROW_LOCK,
        [market.marketId],
        () =>
          createFleetSelectionModel(h.shipping, admin('sr-race-proposer-5a'), {
            name,
            rule: RULE,
            note: 'Drivers first',
          }),
        () =>
          createFleetSelectionModel(h.shipping, admin('sr-race-proposer-5b'), {
            name: name.toUpperCase(),
            rule: { kind: 'cheapest' },
            note: 'Cheapest first',
          }),
      );
      const filed = [one, two].filter((answer) => answer.ok);
      const refused = [one, two].filter((answer) => !answer.ok);
      expect(filed).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const request = filed[0]!.ok && 'request' in filed[0]!.value ? filed[0]!.value.request : null;
      expect(request).not.toBeNull();
      expect(!refused[0]!.ok && refused[0]!.error).toEqual({
        code: 'system-requests.already-pending',
        pendingNumber: request!.number,
      });
      const rows = await h.sql.query<{ id: string; status: string; mode: string }>(
        `SELECT id, status, mode FROM system_requests.requests
         WHERE market_id = $1 AND subject_ref = $2`,
        [market.marketId, fleetModelNameRef(name)],
      );
      expect(rows.rows).toEqual([{ id: request!.id, status: 'open', mode: 'approval' }]);
      expect(await modelsNamed(name)).toEqual([]);
    });

    it('applies a proposal once when two admins approve it at once', async () => {
      const name = unique('Approved twice');
      const proposed = await createFleetSelectionModel(h.shipping, admin('sr-race-proposer-6'), {
        name,
        rule: RULE,
        note: 'Drivers first',
      });
      if (!proposed.ok || !('request' in proposed.value)) throw new Error('no proposal filed');
      const requestId = proposed.value.request.id;
      const answers = await atOnce(
        REQUEST_ROW_LOCK,
        onRequest(requestId),
        () => approveRequest(h.deps, admin('sr-race-approver-6a'), { requestId }),
        () => approveRequest(h.deps, admin('sr-race-approver-6b'), { requestId }),
      );
      expect(answers.map(codeOf).sort()).toEqual(['ok', 'system-requests.decided']);
      const models = await modelsNamed(name);
      expect(models).toHaveLength(1);
      expect(
        (await auditOf(models[0]!.id)).map((line) => [line.action, line.after?.requestId]),
      ).toEqual([['shipping.fleet-model.created', requestId]]);
      expect(await requestRow(requestId)).toMatchObject({ status: 'approved' });
      expect(await historyOf(requestId)).toEqual(['proposed', 'approved']);
      expect(await decisionsAudited(requestId)).toEqual(['system-requests.request.approved']);
    });

    it('approve racing the author withdrawing a proposal: applied only if approved', async () => {
      const name = unique('Taken back');
      const author = admin('sr-race-proposer-7');
      const proposed = await createFleetSelectionModel(h.shipping, author, {
        name,
        rule: RULE,
        note: 'Drivers first',
      });
      if (!proposed.ok || !('request' in proposed.value)) throw new Error('no proposal filed');
      const requestId = proposed.value.request.id;
      const [approved, withdrawn] = await atOnce(
        REQUEST_ROW_LOCK,
        onRequest(requestId),
        () => approveRequest(h.deps, admin('sr-race-approver-7'), { requestId }),
        () => withdrawRequest(h.deps, author, { requestId, reason: 'Not needed' }),
      );
      expect([codeOf(approved), codeOf(withdrawn)].sort()).toEqual([
        'ok',
        'system-requests.decided',
      ]);
      if (approved.ok) {
        expect(await modelsNamed(name)).toHaveLength(1);
        expect(await requestRow(requestId)).toMatchObject({ status: 'approved' });
        expect(await historyOf(requestId)).toEqual(['proposed', 'approved']);
      } else {
        expect(await modelsNamed(name)).toEqual([]);
        expect(await requestRow(requestId)).toMatchObject({
          status: 'reverted',
          decision: 'withdrawn',
        });
        expect(await historyOf(requestId)).toEqual(['proposed', 'withdrawn']);
      }
      expect(await decisionsAudited(requestId)).toHaveLength(1);
    });
  });
});
