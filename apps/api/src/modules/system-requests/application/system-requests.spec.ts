import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  SYSTEM_REQUESTS_CATALOGUE_REVIEW,
  SYSTEM_REQUESTS_MARKETPLACE_REVIEW,
  SYSTEM_REQUESTS_PEOPLE_REVIEW,
  SYSTEM_REQUESTS_POLICY_MANAGE,
  SYSTEM_REQUESTS_POLICY_VIEW,
  SYSTEM_REQUESTS_REQUEST_VIEW,
} from '../contracts/permissions';
import type { AppliedChange } from '../contracts/recorder';
import {
  SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP,
  SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP,
} from '../contracts/step-up';
import { listRequests } from './list-flow';
import { changeAreaPolicy, DUE_DAYS_KIND, POLICY_AREA_KIND, PolicyReverter } from './policy-flow';
import { approveRequest, commentOnRequest, withdrawRequest } from './request-flow';
import { ReverterRegistry, ReverterRegistryError } from './reverter-registry';
import { SystemRequestRecorderImplementation } from './system-request-recorder';
import type { SystemRequestsDependencies } from './system-requests-dependencies';
import {
  FakeStepUp,
  FakeSubjects,
  InMemoryPolicy,
  InMemoryRequests,
} from './testing/in-memory-system-requests';
import { ApproveSystemRequest } from './use-cases/approve-system-request.use-case';
import { ApproveSystemRequests } from './use-cases/approve-system-requests.use-case';
import { ChangeAreaReviewPolicy } from './use-cases/change-area-review-policy.use-case';
import { ChangeReviewDueDays } from './use-cases/change-review-due-days.use-case';
import { CommentOnSystemRequest } from './use-cases/comment-on-system-request.use-case';
import { CountSystemRequests } from './use-cases/count-system-requests.use-case';
import { ListSystemRequests } from './use-cases/list-system-requests.use-case';
import { RejectSystemRequest } from './use-cases/reject-system-request.use-case';
import { ViewReviewPolicy } from './use-cases/view-review-policy.use-case';
import { ViewSystemRequest } from './use-cases/view-system-request.use-case';
import { WithdrawSystemRequest } from './use-cases/withdraw-system-request.use-case';

// System requests end to end in memory, on both Market fixtures (owner decisions of 15 Nov 2026):
// a change in a reviewed area stays live and opens a request; another admin who reviews the area
// approves (the change stays) or rejects (the value before returns, only if nobody changed it
// since); the author never decides their own change but may withdraw it; high risk spends a
// step-up proof; bulk approve takes low risk only; the list is a super list (views with counts,
// filters, search, page numbers with a total, or a cursor).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MAKER = id<'Account'>(0xa1);
const CHECKER = id<'Account'>(0xa2);
const OUTSIDER = id<'Account'>(0xa3);
const STRANGER = id<'Account'>(0xa4);
const START = Temporal.Instant.from('2026-11-15T01:00:00Z');
const SETTING = 'settings.market-setting';
/** The kind the settings module would register in each area these tests use. */
const KIND_OF = {
  catalogue: SETTING,
  people: 'settings.people-setting',
  marketplace: 'settings.listing-rule',
} as const;

type AuditEntry = Parameters<AuditWriter['record']>[1];

class Audit implements AuditWriter {
  readonly rows: (AuditEntry & { readonly market: string })[] = [];
  record(context: CallContext, entry: AuditEntry): Promise<void> {
    this.rows.push({ ...entry, market: context.market.marketId });
    return Promise.resolve();
  }
}

const VIEW = SYSTEM_REQUESTS_REQUEST_VIEW.key;
const KEYS: Readonly<Record<string, readonly string[]>> = {
  [MAKER]: [VIEW, SYSTEM_REQUESTS_CATALOGUE_REVIEW.key, SYSTEM_REQUESTS_POLICY_VIEW.key],
  [CHECKER]: [
    VIEW,
    SYSTEM_REQUESTS_CATALOGUE_REVIEW.key,
    SYSTEM_REQUESTS_PEOPLE_REVIEW.key,
    SYSTEM_REQUESTS_MARKETPLACE_REVIEW.key,
    SYSTEM_REQUESTS_POLICY_VIEW.key,
    SYSTEM_REQUESTS_POLICY_MANAGE.key,
  ],
  [OUTSIDER]: [VIEW, SYSTEM_REQUESTS_POLICY_MANAGE.key],
  [STRANGER]: [],
};

describe.each([['AU'], ['ZZ']] as const)('system requests in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const authorisation = {
    check: (context: CallContext, declaration: AccessDeclaration) => {
      const actor = context.actor;
      const rule = declaration.rule;
      let allowed = rule.kind === 'system' ? actor.kind === 'system' : true;
      if (rule.kind === 'permissions') {
        const held = actor.kind === 'authenticated' ? (KEYS[actor.accountId] ?? []) : [];
        allowed = rule.allOf.every((key) => held.includes(key));
      }
      return Promise.resolve(
        allowed
          ? ({ allowed: true } as const)
          : ({ allowed: false, denial: { code: 'access.denied' } } as const),
      );
    },
  };
  const gate = createUseCaseGate(markets, authorisation);
  const admin = (accountId: Id<'Account'>, ctx = market) =>
    testCallContext(
      ctx,
      testAuthenticatedActor(ctx, {
        population: 'admin',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
    );
  const actingAs = (accountId: Id<'Account'>): CallContext => {
    const base = admin(accountId);
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: CHECKER } } as never };
  };

  let clock: FixedClock;
  let requests: InMemoryRequests;
  let policy: InMemoryPolicy;
  let stepUp: FakeStepUp;
  let subjects: FakeSubjects;
  let registry: ReverterRegistry;
  let audit: Audit;
  let deps: SystemRequestsDependencies;
  let recorder: SystemRequestRecorderImplementation;
  const useCase = <U>(type: new (g: typeof gate, d: SystemRequestsDependencies) => U) =>
    new type(gate, deps);

  beforeEach(() => {
    clock = new FixedClock(START);
    requests = new InMemoryRequests();
    policy = new InMemoryPolicy();
    stepUp = new FakeStepUp(clock);
    subjects = new FakeSubjects();
    registry = new ReverterRegistry();
    audit = new Audit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      requests,
      policy,
      reverters: registry,
      authorisation,
      stepUp,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    for (const [area, kind] of Object.entries(KIND_OF)) {
      registry.facade.register('settings', kind, area as keyof typeof KIND_OF, subjects);
    }
    registry.register(
      'system-requests',
      POLICY_AREA_KIND,
      'review-policy',
      new PolicyReverter(deps, POLICY_AREA_KIND),
    );
    registry.register(
      'system-requests',
      DUE_DAYS_KIND,
      'review-policy',
      new PolicyReverter(deps, DUE_DAYS_KIND),
    );
    registry.seal();
    recorder = new SystemRequestRecorderImplementation(deps);
  });

  /** What the settings module would do: write the value, then open the review in the same unit. */
  const change = async (
    who: Id<'Account'>,
    ref: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    extra: Partial<AppliedChange> = {},
  ) => {
    subjects.set(market.marketId, ref, after);
    const area = (extra.area ?? 'catalogue') as keyof typeof KIND_OF;
    const opened = await recorder.openReview(admin(who), {
      area,
      subjectKind: KIND_OF[area],
      subjectRef: ref,
      before: before as AppliedChange['before'],
      after: after as AppliedChange['after'],
      note: 'Raise the limit for the launch week',
      ...extra,
    });
    if (!opened.ok || opened.value === null) throw new Error('expected a request');
    return opened.value;
  };

  describe('opening a request (the recorder)', () => {
    it('opens a request at the area risk, numbered per Market, due after the review period', async () => {
      const first = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(first).toMatchObject({
        number: 1,
        risk: 'medium',
        reviewDueAt: START.add({ hours: 7 * 24 }),
      });
      const second = await change(MAKER, 'cart-mode', { mode: 'multi' }, { mode: 'single' });
      expect(second.number).toBe(2);
      expect(audit.rows.map((row) => row.action)).toEqual([
        'system-requests.request.opened',
        'system-requests.request.opened',
      ]);
      // The other Market keeps its own counter and sees none of these.
      const elsewhere = await recorder.openReview(admin(MAKER, other), {
        area: 'catalogue',
        subjectKind: SETTING,
        subjectRef: 'list-paging',
        before: { size: 25 },
        after: { size: 30 },
        note: 'Elsewhere',
      });
      expect(elsewhere.ok && elsewhere.value?.number).toBe(1);
      expect(await requests.find(other, first.id)).toBeNull();
    });

    it('raises the risk on request and never lowers it', async () => {
      expect((await change(MAKER, 'a', { v: 1 }, { v: 2 }, { risk: 'high' })).risk).toBe('high');
      expect((await change(MAKER, 'b', { v: 1 }, { v: 2 }, { risk: 'low' })).risk).toBe('medium');
    });

    it('opens nothing for an area that is not reviewed in the Market, or for no change', async () => {
      const off = await recorder.openReview(admin(MAKER), {
        area: 'marketplace',
        subjectKind: KIND_OF.marketplace,
        subjectRef: 'x',
        before: { v: 1 },
        after: { v: 2 },
        note: 'n',
      });
      expect(off).toEqual({ ok: true, value: null });
      // No note is needed where nothing is reviewed.
      const noNote = await recorder.openReview(admin(MAKER), {
        area: 'marketplace',
        subjectKind: KIND_OF.marketplace,
        subjectRef: 'x',
        before: { v: 1 },
        after: { v: 2 },
        note: undefined,
      });
      expect(noNote).toEqual({ ok: true, value: null });
      const same = await recorder.openReview(admin(MAKER), {
        area: 'catalogue',
        subjectKind: SETTING,
        subjectRef: 'x',
        before: { v: 1 },
        after: { v: 1 },
        note: 'n',
      });
      expect(same).toEqual({ ok: true, value: null });
      expect(requests.rows).toHaveLength(0);
    });

    it('refuses a missing note, a non-admin and an acting-as session', async () => {
      const base = {
        area: 'catalogue' as const,
        subjectKind: SETTING,
        subjectRef: 'x',
        before: { v: 1 },
        after: { v: 2 },
      };
      expect(await recorder.openReview(admin(MAKER), { ...base, note: '  ' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note' }] },
      });
      expect(
        await recorder.openReview(admin(MAKER), { ...base, note: 'x'.repeat(501) }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(await recorder.openReview(actingAs(MAKER), { ...base, note: 'n' })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await recorder.openReview(testCallContext(market, 'system'), { ...base, note: 'n' }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('throws on a programming error of the calling module', async () => {
      const base = {
        area: 'catalogue' as const,
        subjectKind: SETTING,
        subjectRef: 'x',
        before: { v: 1 },
        after: { v: 2 },
        note: 'n',
      };
      await expect(
        recorder.openReview(admin(MAKER), { ...base, subjectKind: 'catalog.unregistered' }),
      ).rejects.toThrow(TypeError);
      await expect(
        recorder.openReview(admin(MAKER), { ...base, subjectRef: 'bad key!' }),
      ).rejects.toThrow(TypeError);
      await expect(
        recorder.openReview(admin(MAKER), {
          ...base,
          after: { deep: { deeper: { deepest: { tooDeep: 1 } } } },
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        recorder.openReview(admin(MAKER), { ...base, subjectKind: POLICY_AREA_KIND }),
      ).rejects.toThrow(TypeError);
      // A kind is reviewed in the area it was registered in, never filed under another one.
      await expect(recorder.openReview(admin(MAKER), { ...base, area: 'content' })).rejects.toThrow(
        TypeError,
      );
      await expect(
        recorder.openReview(admin(MAKER), { ...base, subjectKind: KIND_OF.people }),
      ).rejects.toThrow(TypeError);
      // Text in the values holds no control character (the database would grow it).
      await expect(
        recorder.openReview(admin(MAKER), { ...base, after: { v: 'a\u0000b' } }),
      ).rejects.toThrow(TypeError);
    });

    it('marks the earlier requests of the same subject as superseded', async () => {
      const first = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      const second = await change(CHECKER, 'list-paging', { size: 50 }, { size: 100 });
      expect((await requests.find(market, first.id))?.supersededBy).toBe(second.id);
      expect((await requests.find(market, second.id))?.supersededBy).toBeNull();
    });

    it('answers the area policy from a read-only unit, and the default on a failure', async () => {
      expect(await recorder.areaPolicy(admin(MAKER), 'people')).toEqual({
        enabled: true,
        risk: 'high',
      });
      expect(await recorder.areaPolicy(admin(MAKER), 'content')).toEqual({
        enabled: false,
        risk: 'low',
      });
      jest.spyOn(policy, 'area').mockRejectedValueOnce(new Error('down'));
      expect(await recorder.areaPolicy(admin(MAKER), 'money')).toEqual({
        enabled: true,
        risk: 'high',
      });
    });
  });

  describe('decisions', () => {
    it('lets another reviewer of the area approve; the change stays live', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      const approved = await useCase(ApproveSystemRequest).execute(admin(CHECKER), {
        requestId: opened.id,
      });
      expect(approved).toMatchObject({
        ok: true,
        value: {
          status: 'approved',
          decision: 'approved',
          decidedBy: CHECKER,
          actions: ['open', 'copy-link'],
        },
      });
      expect(subjects.get(market.marketId, 'list-paging')).toEqual({ size: 50 });
      expect(stepUp.spent).toEqual([]);
      const again = await useCase(ApproveSystemRequest).execute(admin(CHECKER), {
        requestId: opened.id,
      });
      expect(again).toEqual({ ok: false, error: { code: 'system-requests.decided' } });
      expect(audit.rows.at(-1)).toMatchObject({ action: 'system-requests.request.approved' });
    });

    it('never lets the author decide their own change (maker-checker)', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(
        await useCase(ApproveSystemRequest).execute(admin(MAKER), { requestId: opened.id }),
      ).toEqual({ ok: false, error: { code: 'system-requests.own-request' } });
      expect(
        await useCase(RejectSystemRequest).execute(admin(MAKER), {
          requestId: opened.id,
          reason: 'mine',
        }),
      ).toEqual({ ok: false, error: { code: 'system-requests.own-request' } });
    });

    it('refuses an admin without the area review key, and one without the queue key', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(
        await useCase(ApproveSystemRequest).execute(admin(OUTSIDER), { requestId: opened.id }),
      ).toEqual({ ok: false, error: { code: 'system-requests.not-reviewer' } });
      expect(
        await useCase(ApproveSystemRequest).execute(admin(STRANGER), { requestId: opened.id }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(await useCase(ListSystemRequests).execute(admin(STRANGER), {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('refuses every write in an acting-as session', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(await approveRequest(deps, actingAs(CHECKER), { requestId: opened.id })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(
        await withdrawRequest(deps, actingAs(MAKER), { requestId: opened.id, reason: 'x' }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await commentOnRequest(deps, actingAs(CHECKER), { requestId: opened.id, body: 'x' }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await listRequests(deps, actingAs(CHECKER), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('needs a fresh step-up proof for a high-risk decision, and spends it once', async () => {
      const opened = await change(
        MAKER,
        'payout-hold',
        { days: 2 },
        { days: 0 },
        {
          area: 'people',
        },
      );
      expect(opened.risk).toBe('high');
      expect(
        await useCase(ApproveSystemRequest).execute(admin(CHECKER), { requestId: opened.id }),
      ).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP },
      });
      stepUp.grant(CHECKER, SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP);
      const approved = await useCase(ApproveSystemRequest).execute(admin(CHECKER), {
        requestId: opened.id,
      });
      expect(approved.ok).toBe(true);
      expect(stepUp.spent).toEqual([
        { account: CHECKER, action: SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP },
      ]);
      expect(audit.rows.at(-1)).toMatchObject({
        action: 'system-requests.request.approved',
        after: { stepUpSessionId: id<'Session'>(0x61) },
      });
    });

    it('rejects with a reason and restores the value before', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(
        await useCase(RejectSystemRequest).execute(admin(CHECKER), {
          requestId: opened.id,
          reason: '',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      const rejected = await useCase(RejectSystemRequest).execute(admin(CHECKER), {
        requestId: opened.id,
        reason: 'Too large for phones',
      });
      expect(rejected).toMatchObject({
        ok: true,
        value: { status: 'reverted', decision: 'rejected', decisionReason: 'Too large for phones' },
      });
      expect(subjects.get(market.marketId, 'list-paging')).toEqual({ size: 25 });
      const lines = await requests.activity(market, opened.id);
      expect(lines.map((line) => line.kind)).toEqual(['applied', 'rejected']);
    });

    it('does not revert when the subject changed since, outside a review', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      subjects.set(market.marketId, 'list-paging', { size: 75 });
      expect(
        await useCase(RejectSystemRequest).execute(admin(CHECKER), {
          requestId: opened.id,
          reason: 'No',
        }),
      ).toEqual({
        ok: false,
        error: { code: 'system-requests.changed-since', newerRequestId: null },
      });
      expect(subjects.get(market.marketId, 'list-paging')).toEqual({ size: 75 });
      expect((await requests.find(market, opened.id))?.status).toBe('open');
    });

    it('does not revert a superseded request, and names the newer one', async () => {
      const first = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      const second = await change(MAKER, 'list-paging', { size: 50 }, { size: 100 });
      expect(
        await useCase(RejectSystemRequest).execute(admin(CHECKER), {
          requestId: first.id,
          reason: 'No',
        }),
      ).toEqual({
        ok: false,
        error: { code: 'system-requests.changed-since', newerRequestId: second.id },
      });
      expect(subjects.reverts).toHaveLength(0);
      // A superseded request can still be approved (the change it records stays).
      const view = await useCase(ViewSystemRequest).execute(admin(CHECKER), {
        requestId: first.id,
      });
      expect(view.ok && view.value.actions).toEqual(['open', 'copy-link', 'approve']);
    });

    it('releases the earlier requests when the newer one is reverted (Hassan H1)', async () => {
      // The author changes twice, then withdraws the second change: the first is the latest
      // again and a reviewer can still reject it, which restores the original value.
      const first = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      const second = await change(MAKER, 'list-paging', { size: 50 }, { size: 10 });
      expect(
        await useCase(WithdrawSystemRequest).execute(admin(MAKER), {
          requestId: second.id,
          reason: 'Undo the second step',
        }),
      ).toMatchObject({ ok: true, value: { status: 'reverted', decision: 'withdrawn' } });
      expect(subjects.get(market.marketId, 'list-paging')).toEqual({ size: 50 });
      expect((await requests.find(market, first.id))?.supersededBy).toBeNull();
      const view = await useCase(ViewSystemRequest).execute(admin(CHECKER), {
        requestId: first.id,
      });
      expect(view.ok && view.value.actions).toEqual(['open', 'copy-link', 'approve', 'reject']);
      expect(
        await useCase(RejectSystemRequest).execute(admin(CHECKER), {
          requestId: first.id,
          reason: 'No',
        }),
      ).toMatchObject({ ok: true, value: { status: 'reverted', decision: 'rejected' } });
      expect(subjects.get(market.marketId, 'list-paging')).toEqual({ size: 25 });
    });

    it('shows the values only to the author and the area reviewers (Hassan L2)', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      const valuesFor = async (who: Id<'Account'>) => {
        const view = await useCase(ViewSystemRequest).execute(admin(who), {
          requestId: opened.id,
        });
        return view.ok ? [view.value.before, view.value.after] : null;
      };
      expect(await valuesFor(MAKER)).toEqual([{ size: 25 }, { size: 50 }]);
      expect(await valuesFor(CHECKER)).toEqual([{ size: 25 }, { size: 50 }]);
      expect(await valuesFor(OUTSIDER)).toEqual([null, null]);
      const listed = await useCase(ListSystemRequests).execute(admin(OUTSIDER), {});
      expect(listed.ok && listed.value.rows.map((row) => row.after)).toEqual([null]);
    });

    it('answers subject-gone when the subject no longer exists', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      subjects.values.clear();
      expect(
        await useCase(RejectSystemRequest).execute(admin(CHECKER), {
          requestId: opened.id,
          reason: 'No',
        }),
      ).toEqual({ ok: false, error: { code: 'system-requests.subject-gone' } });
    });

    it('answers revert-not-permitted when the owning module refuses the decider, and keeps the request open', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      subjects.refused.add('list-paging');
      expect(
        await useCase(RejectSystemRequest).execute(admin(CHECKER), {
          requestId: opened.id,
          reason: 'No',
        }),
      ).toEqual({ ok: false, error: { code: 'system-requests.revert-not-permitted' } });
      const view = await useCase(ViewSystemRequest).execute(admin(CHECKER), {
        requestId: opened.id,
      });
      expect(view.ok && view.value.status).toBe('open');
    });

    it('lets only the author withdraw, which restores the value before', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(
        await useCase(WithdrawSystemRequest).execute(admin(CHECKER), {
          requestId: opened.id,
          reason: 'x',
        }),
      ).toEqual({ ok: false, error: { code: 'system-requests.not-author' } });
      const withdrawn = await useCase(WithdrawSystemRequest).execute(admin(MAKER), {
        requestId: opened.id,
        reason: 'Wrong Market',
      });
      expect(withdrawn).toMatchObject({
        ok: true,
        value: { status: 'reverted', decision: 'withdrawn', decidedBy: MAKER },
      });
      expect(subjects.get(market.marketId, 'list-paging')).toEqual({ size: 25 });
    });

    it('finds no request of another Market', async () => {
      const opened = await change(MAKER, 'list-paging', { size: 25 }, { size: 50 });
      expect(
        await useCase(ApproveSystemRequest).execute(admin(CHECKER, other), {
          requestId: opened.id,
        }),
      ).toEqual({ ok: false, error: { code: 'system-requests.not-found' } });
      expect(
        await useCase(ViewSystemRequest).execute(admin(CHECKER, other), { requestId: opened.id }),
      ).toEqual({ ok: false, error: { code: 'system-requests.not-found' } });
    });
  });

  describe('bulk approve', () => {
    beforeEach(() => {
      policy.areaRows.set(`${market.marketId}:marketplace`, {
        area: 'marketplace',
        enabled: true,
        risk: 'low',
        version: 1,
        updatedAt: START,
        updatedBy: CHECKER,
      });
    });

    it('approves low-risk requests only, one by one, and reports each outcome', async () => {
      const low = await change(MAKER, 'a', { v: 1 }, { v: 2 }, { area: 'marketplace' });
      const medium = await change(MAKER, 'b', { v: 1 }, { v: 2 });
      const own = await change(CHECKER, 'c', { v: 1 }, { v: 2 }, { area: 'marketplace' });
      const result = await useCase(ApproveSystemRequests).execute(admin(CHECKER), {
        requestIds: [low.id, medium.id, own.id],
      });
      expect(result).toEqual({
        ok: true,
        value: [
          { requestId: low.id, outcome: 'approved' },
          { requestId: medium.id, outcome: 'system-requests.not-low-risk' },
          { requestId: own.id, outcome: 'system-requests.own-request' },
        ],
      });
    });

    it('refuses an empty, oversized or duplicated list', async () => {
      const approve = (requestIds: unknown) =>
        useCase(ApproveSystemRequests).execute(admin(CHECKER), { requestIds });
      expect(await approve([])).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(await approve(Array.from({ length: 101 }, (_, n) => id(0x1000 + n)))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await approve([id(1), id(1)])).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'requestIds', code: 'duplicate' }] },
      });
      expect(await approve(['not-an-id'])).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });
  });

  describe('the list (super list)', () => {
    const list = (who: Id<'Account'>, input: Record<string, unknown> = {}) =>
      useCase(ListSystemRequests).execute(admin(who), input);

    it('counts every view and lists the default view (all open)', async () => {
      const mine = await change(MAKER, 'a', { v: 1 }, { v: 2 });
      await change(CHECKER, 'b', { v: 1 }, { v: 2 });
      const decided = await change(MAKER, 'c', { v: 1 }, { v: 2 });
      await useCase(ApproveSystemRequest).execute(admin(CHECKER), { requestId: decided.id });

      const forChecker = await list(CHECKER);
      if (!forChecker.ok) throw new Error('list failed');
      expect(forChecker.value.counts).toEqual({
        'needs-my-review': 1,
        'all-open': 2,
        mine: 1,
        approved: 1,
        reverted: 0,
        overdue: 0,
        all: 3,
      });
      expect(forChecker.value.rows).toHaveLength(2);
      const row = forChecker.value.rows.find((candidate) => candidate.id === mine.id);
      expect(row?.actions).toEqual(['open', 'copy-link', 'approve', 'reject']);
      expect(row?.reviewPermission).toBe(SYSTEM_REQUESTS_CATALOGUE_REVIEW.key);

      // The outsider reviews no area: nothing needs their review, and rows offer no decision.
      const forOutsider = await list(OUTSIDER);
      if (!forOutsider.ok) throw new Error('list failed');
      expect(forOutsider.value.counts['needs-my-review']).toBe(0);
      expect(forOutsider.value.rows.every((r) => r.actions.length === 2)).toBe(true);
    });

    it('shows an open request past its review date as overdue', async () => {
      await change(MAKER, 'a', { v: 1 }, { v: 2 });
      clock.advance(Temporal.Duration.from({ hours: 7 * 24 }));
      const result = await list(CHECKER, { view: 'overdue' });
      expect(result.ok && result.value.rows.map((r) => r.overdue)).toEqual([true]);
      const badge = await useCase(CountSystemRequests).execute(admin(CHECKER), {});
      expect(badge).toEqual({ ok: true, value: { needsMyReview: 1, overdue: 1 } });
    });

    it('pages with numbers and a total, or with a cursor, over the same rows', async () => {
      for (let n = 0; n < 7; n += 1) {
        clock.advance(Temporal.Duration.from({ minutes: 1 }));
        await change(MAKER, `s${n}`, { v: n }, { v: n + 1 });
      }
      const second = await list(CHECKER, { view: 'all', page: '2', pageSize: '3', sort: 'number' });
      expect(second.ok && second.value.rows.map((r) => r.number)).toEqual([4, 5, 6]);
      expect(second.ok && second.value.total).toBe(7);

      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const pageOf = await list(CHECKER, {
          view: 'all',
          pageSize: '3',
          sort: 'applied',
          direction: 'desc',
          ...(cursor === null ? {} : { cursor }),
        });
        if (!pageOf.ok) throw new Error('page failed');
        expect(pageOf.value.total).toBeNull();
        seen.push(...pageOf.value.rows.map((r) => r.number));
        cursor = pageOf.value.nextCursor;
      } while (cursor !== null);
      expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });

    it('searches by SR number or text, and filters by area, risk and author', async () => {
      await change(MAKER, 'list-paging', { v: 1 }, { v: 2 });
      await change(MAKER, 'cart-mode', { v: 1 }, { v: 2 }, { area: 'people' });
      const byNumber = await list(CHECKER, { view: 'all', q: 'SR-2' });
      expect(byNumber.ok && byNumber.value.rows.map((r) => r.subjectRef)).toEqual(['cart-mode']);
      const byText = await list(CHECKER, { view: 'all', q: 'PAGING' });
      expect(byText.ok && byText.value.rows.map((r) => r.subjectRef)).toEqual(['list-paging']);
      const byRisk = await list(CHECKER, { view: 'all', risk: 'high' });
      expect(byRisk.ok && byRisk.value.rows.map((r) => r.area)).toEqual(['people']);
      const byAuthor = await list(CHECKER, { view: 'all', requestedBy: CHECKER });
      expect(byAuthor.ok && byAuthor.value.rows).toEqual([]);
      // View counts follow the active filters: "Mine" with someone else as author is empty.
      const mineAsOther = await list(MAKER, { view: 'mine', requestedBy: CHECKER });
      expect(mineAsOther.ok && mineAsOther.value.counts.mine).toBe(0);
      expect(mineAsOther.ok && mineAsOther.value.rows).toEqual([]);
    });

    it('refuses a malformed query', async () => {
      const refused = await list(CHECKER, {
        view: 'everything',
        risk: 'extreme',
        page: '0',
        sort: 'random',
      });
      expect(refused).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(await list(CHECKER, { page: '1', cursor: 'abc' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'cursor', code: 'with-page' }] },
      });
      expect(await list(CHECKER, { cursor: 'not-base64-json' })).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'cursor', code: 'format' }] },
      });
    });
  });

  describe('comments', () => {
    it('adds a comment to the history and counts it, on any status', async () => {
      const opened = await change(MAKER, 'a', { v: 1 }, { v: 2 });
      await useCase(ApproveSystemRequest).execute(admin(CHECKER), { requestId: opened.id });
      const commented = await useCase(CommentOnSystemRequest).execute(admin(OUTSIDER), {
        requestId: opened.id,
        body: 'Checked with finance',
      });
      expect(commented).toMatchObject({ ok: true, value: { kind: 'commented', actor: OUTSIDER } });
      const view = await useCase(ViewSystemRequest).execute(admin(MAKER), { requestId: opened.id });
      expect(view.ok && view.value.commentCount).toBe(1);
      expect(view.ok && view.value.activity.map((line) => line.kind)).toEqual([
        'applied',
        'approved',
        'commented',
      ]);
      expect(
        await useCase(CommentOnSystemRequest).execute(admin(OUTSIDER), {
          requestId: opened.id,
          body: 'x'.repeat(2001),
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });

  describe('the review policy', () => {
    it('shows the defaults when nothing is stored', async () => {
      const view = await useCase(ViewReviewPolicy).execute(admin(MAKER), {});
      if (!view.ok) throw new Error('view failed');
      expect(view.value.areas.find((area) => area.area === 'people')).toMatchObject({
        enabled: true,
        risk: 'high',
        version: 0,
      });
      expect(view.value.reviewDueDays).toMatchObject({ reviewDueDays: 7, version: 0 });
      expect(await useCase(ViewReviewPolicy).execute(admin(STRANGER), {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('changes an area under a step-up proof and opens a high-risk review of the change', async () => {
      const input = {
        area: 'content',
        enabled: true,
        risk: 'medium',
        expectedVersion: 0,
        note: 'Review page edits from now on',
      };
      expect(await useCase(ChangeAreaReviewPolicy).execute(admin(OUTSIDER), input)).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP },
      });
      stepUp.grant(OUTSIDER, SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP);
      const changed = await useCase(ChangeAreaReviewPolicy).execute(admin(OUTSIDER), input);
      expect(changed).toMatchObject({
        ok: true,
        value: { value: { enabled: true, risk: 'medium', version: 1 }, request: { risk: 'high' } },
      });
      expect(await recorder.areaPolicy(admin(MAKER), 'content')).toEqual({
        enabled: true,
        risk: 'medium',
      });
      // A stale version is refused.
      stepUp.grant(OUTSIDER, SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP);
      expect(
        await useCase(ChangeAreaReviewPolicy).execute(admin(OUTSIDER), { ...input, risk: 'low' }),
      ).toEqual({ ok: false, error: { code: 'system-requests.policy-conflict' } });

      // A people reviewer rejects the change (high risk: step-up), and the policy returns.
      const requestId = changed.ok ? changed.value.request?.id : undefined;
      stepUp.grant(CHECKER, SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP);
      const rejected = await useCase(RejectSystemRequest).execute(admin(CHECKER), {
        requestId,
        reason: 'Not this quarter',
      });
      expect(rejected).toMatchObject({ ok: true, value: { status: 'reverted' } });
      expect(await recorder.areaPolicy(admin(MAKER), 'content')).toEqual({
        enabled: false,
        risk: 'low',
      });
      expect(policy.areaRows.get(`${market.marketId}:content`)?.version).toBe(2);
      // The revert opened no new request.
      expect(requests.rows).toHaveLength(1);
    });

    it('changes the review period, which sets the due date of later requests', async () => {
      stepUp.grant(OUTSIDER, SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP);
      const changed = await useCase(ChangeReviewDueDays).execute(admin(OUTSIDER), {
        reviewDueDays: 3,
        expectedVersion: 0,
        note: 'Faster reviews',
      });
      expect(changed).toMatchObject({ ok: true, value: { value: { reviewDueDays: 3 } } });
      const later = await change(MAKER, 'a', { v: 1 }, { v: 2 });
      expect(later.reviewDueAt).toEqual(START.add({ hours: 3 * 24 }));
      expect(
        await useCase(ChangeReviewDueDays).execute(admin(OUTSIDER), {
          reviewDueDays: 91,
          expectedVersion: 1,
          note: 'x',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('refuses a policy change in an acting-as session', async () => {
      expect(
        await changeAreaPolicy(deps, actingAs(OUTSIDER), {
          area: 'content',
          enabled: true,
          risk: 'low',
          expectedVersion: 0,
          note: 'x',
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });
});

describe('the reverter registry', () => {
  const reverter = { revert: () => Promise.resolve('reverted' as const) };

  it('takes a kind of the registering module once, in one area, and nothing after it is sealed', () => {
    const registry = new ReverterRegistry();
    const register = (...args: Parameters<typeof registry.facade.register>) =>
      registry.facade.register(...args);
    register('settings', 'settings.market-setting', 'catalogue', reverter);
    expect(() => register('settings', 'settings.market-setting', 'catalogue', reverter)).toThrow(
      ReverterRegistryError,
    );
    expect(() => register('settings', 'catalog.product', 'catalogue', reverter)).toThrow(
      ReverterRegistryError,
    );
    expect(() => register('settings', 'settings', 'catalogue', reverter)).toThrow(
      ReverterRegistryError,
    );
    // Only system-requests registers in the review-policy area, and not through the facade.
    expect(() =>
      register('settings', 'settings.policy', 'review-policy' as never, reverter),
    ).toThrow(ReverterRegistryError);
    expect(() =>
      registry.register('settings', 'settings.policy', 'review-policy', reverter),
    ).toThrow(ReverterRegistryError);
    // The facade hands out no lookup.
    expect(Object.keys(registry.facade)).toEqual(['register']);
    registry.seal();
    expect(() => register('catalog', 'catalog.product', 'catalogue', reverter)).toThrow(
      ReverterRegistryError,
    );
    expect(registry.find('settings.market-setting')).toEqual({ reverter, area: 'catalogue' });
    expect(registry.find('catalog.product')).toBeNull();
  });
});
