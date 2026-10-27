import { err, ok, Temporal } from '@mondapac/shared-kernel';
import { testKeyring } from '../../../../test/support/payments-fakes';
import { expectSystemOnly } from '../../../../test/support/system-only-denial';
import {
  ACCOUNT,
  AMOUNT,
  buildTransferHarness,
  EXTERNAL,
  KEY,
  MARKET_FACTS,
  OTHER_PAYOUT,
  PAYOUT,
  SELLER,
  T0,
  transferEvent,
} from '../../../../test/support/transfer-harness';
import { PaymentsFacadeImplementation } from '../presentation/payments.facade';
import { resolveTransfersJob } from '../presentation/jobs/resolve-transfers.job';

const unavailable = err({ code: 'payments.unavailable' });

describe.each([['AU'], ['ZZ']] as const)(
  'transfer fence, lookup and webhook in market %s',
  (code) => {
    const facts = MARKET_FACTS[code];
    let h: ReturnType<typeof buildTransferHarness>;
    beforeEach(() => {
      h = buildTransferHarness(code);
    });
    const abandon = (key = KEY) => h.useCases.abandon.execute(h.system, key);
    const pastLease = () =>
      h.clock.advance(Temporal.Duration.from({ seconds: facts.leaseSeconds }));

    describe('transferByKey', () => {
      it('answers the stored state of each key in order, with none for an unknown key, in one statement', async () => {
        await h.ready();
        await h.useCases.instruct.execute(h.system, h.request());

        const result = await h.useCases.byKey.execute(h.system, ['unknown', KEY] as never);

        expect(result).toEqual(
          ok([
            {
              instructionKey: 'unknown',
              state: 'none',
              transferExecutionId: null,
              amount: null,
              reversed: null,
            },
            {
              instructionKey: KEY,
              state: 'executed',
              transferExecutionId: h.row()!.id,
              amount: { amount: AMOUNT, currency: facts.currency },
              reversed: { amount: 0n, currency: facts.currency },
            },
          ]),
        );
        expect(h.transfers.manyReads).toBe(1);
        expect(h.transferGateway.lists).toHaveLength(0);
        expect(h.transferGateway.reads).toHaveLength(0);
      });

      it('accepts 100 keys and refuses 101 or a malformed key', async () => {
        const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
        expect((await h.useCases.byKey.execute(h.system, keys as never)).ok).toBe(true);
        expect(await h.useCases.byKey.execute(h.system, [...keys, 'k100'] as never)).toEqual(
          err({ code: 'validation.failed' }),
        );
        expect(await h.useCases.byKey.execute(h.system, ['bad key'] as never)).toEqual(
          err({ code: 'validation.failed' }),
        );
        expect(await h.useCases.byKey.execute(h.system, 'k1' as never)).toEqual(
          err({ code: 'validation.failed' }),
        );
      });

      it('shows a tombstone as abandoned without an amount', async () => {
        await abandon();
        const result = await h.useCases.byKey.execute(h.system, [KEY] as never);
        expect(result).toEqual(
          ok([
            {
              instructionKey: KEY,
              state: 'abandoned',
              transferExecutionId: h.row()!.id,
              amount: null,
              reversed: null,
            },
          ]),
        );
      });
    });

    describe('abandonTransfer', () => {
      it('refuses a malformed key', async () => {
        expect(await abandon('bad key')).toEqual(err({ code: 'validation.failed' }));
      });

      it('writes a tombstone for an unknown key, audits it, and the repeat is still abandoned', async () => {
        const first = await abandon();

        expect(first).toEqual(ok({ kind: 'abandoned', abandonedAt: T0 }));
        expect(h.row()).toMatchObject({ state: 'abandoned', sellerId: null, sendCount: 0 });
        expect(h.audit.rows.map((r) => r.action)).toEqual(['payments.transfer.abandoned']);
        expect(await abandon()).toEqual(ok({ kind: 'still-abandoned' }));
        expect(h.transferGateway.lists).toHaveLength(0);
      });

      it('says in-flight inside the lease and looks nothing up', async () => {
        await h.leaveSending();
        h.clock.advance(Temporal.Duration.from({ seconds: facts.leaseSeconds - 1 }));

        expect(await abandon()).toEqual(ok({ kind: 'in-flight' }));
        expect(h.transferGateway.lists).toHaveLength(0);
        expect(h.row()!.state).toBe('sending');
      });

      it('treats the lease boundary instant as run out and abandons a row not found at Stripe', async () => {
        await h.leaveSending();
        pastLease();

        const result = await abandon();

        expect(result).toEqual(ok({ kind: 'abandoned', abandonedAt: h.clock.now() }));
        expect(h.transferGateway.lists).toEqual([PAYOUT]);
        expect(h.row()).toMatchObject({ state: 'abandoned', sendCount: 1 });
        expect(h.depthAtCall.filter((c) => c.call === 'listTransfersByGroup')).toEqual([
          { call: 'listTransfersByGroup', depth: 0 },
        ]);
        expect(h.outbox.events.map((e) => e.type)).toEqual(['payments.transfer-changed.v1']);
      });

      it('records a transfer found by the lookup as executed', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = ok([h.stripeTransfer()]);

        const result = await abandon();

        expect(result).toEqual(ok({ kind: 'already-sent', transferExecutionId: h.row()!.id }));
        expect(h.row()).toMatchObject({ state: 'executed', providerTransferRef: 'tr_test_0001' });
        expect(h.audit.rows.map((r) => r.action)).toContain('payments.transfer.executed');
      });

      it('is unavailable when the lookup fails, and leaves the row', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = err({ code: 'payment.provider-unavailable' });

        expect(await abandon()).toEqual(unavailable);
        expect(h.row()!.state).toBe('sending');
      });

      it('alerts and is unavailable on a partial match (same key, other amount)', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = ok([h.stripeTransfer({ amountMinor: AMOUNT + 1n })]);

        expect(await abandon()).toEqual(unavailable);
        expect(h.alerts()).toEqual([{ kind: 'partial-match' }]);
        expect(h.row()!.state).toBe('sending');
      });

      it('matches the key, ignoring transfers of other keys in the group', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = ok([h.stripeTransfer({ id: 'tr_other', key: 'other-key' })]);

        expect((await abandon()).ok).toBe(true);
        expect(h.row()!.state).toBe('abandoned');
      });

      it('answers already-sent for an executed row and a definite refusal as abandoned', async () => {
        await h.ready();
        await h.useCases.instruct.execute(h.system, h.request());
        expect(await abandon()).toEqual(
          ok({ kind: 'already-sent', transferExecutionId: h.row()!.id }),
        );

        h.transferGateway.createAnswer = { kind: 'refused', code: 'provider-refused' };
        await h.useCases.instruct.execute(h.system, h.request({ instructionKey: 'refused-one' }));
        expect((await abandon('refused-one')).ok).toBe(true);
        const refused = await abandon('refused-one');
        expect(refused.ok && refused.value.kind).toBe('abandoned');
        expect(h.row('refused-one')!.state).toBe('refused');
      });

      it('runs the quarantine pass on an abandoned row and finds a fence breach', async () => {
        await h.leaveSending();
        pastLease();
        await abandon();
        expect(h.row()!.state).toBe('abandoned');

        // Nothing at Stripe yet: still abandoned.
        expect(await abandon()).toEqual(ok({ kind: 'still-abandoned' }));

        // A transfer appears: the key is executed, stamped, audited and alerted.
        h.transferGateway.listAnswer = ok([h.stripeTransfer()]);
        const result = await abandon();

        expect(result).toEqual(ok({ kind: 'already-sent', transferExecutionId: h.row()!.id }));
        expect(h.row()).toMatchObject({
          state: 'executed',
          providerTransferRef: 'tr_test_0001',
          fenceBreachedAt: h.clock.now(),
        });
        expect(h.alerts()).toEqual([{ kind: 'fence-breached' }]);
        expect(h.audit.rows.map((r) => r.action)).toContain('payments.transfer.fence-breached');
      });

      it('alerts on a partial match during the quarantine pass', async () => {
        await h.leaveSending();
        pastLease();
        await abandon();
        h.transferGateway.listAnswer = ok([h.stripeTransfer({ destination: 'acct_other' })]);

        expect(await abandon()).toEqual(unavailable);
        expect(h.alerts()).toEqual([{ kind: 'partial-match' }]);
        expect(h.row()!.state).toBe('abandoned');
      });

      it('retries when another run moved the row first', async () => {
        await h.leaveSending();
        pastLease();
        const change = h.transfers.change.bind(h.transfers);
        let first = true;
        h.transfers.change = async (...args) => {
          if (first) {
            first = false;
            return false;
          }
          return change(...args);
        };

        expect((await abandon()).ok).toBe(true);
        expect(h.row()!.state).toBe('abandoned');
      });
    });

    describe('resolve-transfers', () => {
      it('records the sends found at Stripe past their lease and never sends', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = ok([h.stripeTransfer()]);

        const result = await h.useCases.resolve.execute(h.system, {});

        expect(result).toEqual(ok({ resolved: 1, pending: 0, alerts: 0 }));
        expect(h.row()!.state).toBe('executed');
        expect(h.transferGateway.creates).toHaveLength(1);
      });

      it('leaves a row inside its lease, one not found, and one whose lookup failed', async () => {
        await h.leaveSending();

        expect(await h.useCases.resolve.execute(h.system, {})).toEqual(
          ok({ resolved: 0, pending: 0, alerts: 0 }),
        );
        expect(h.transferGateway.lists).toHaveLength(0);

        pastLease();
        expect(await h.useCases.resolve.execute(h.system, {})).toEqual(
          ok({ resolved: 0, pending: 1, alerts: 0 }),
        );
        h.transferGateway.listAnswer = err({ code: 'payment.provider-unavailable' });
        expect(await h.useCases.resolve.execute(h.system, {})).toEqual(
          ok({ resolved: 0, pending: 1, alerts: 0 }),
        );
        expect(h.row()!.state).toBe('sending');
      });

      it('alerts on a partial match', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = ok([h.stripeTransfer({ currency: 'xxx' })]);

        expect(await h.useCases.resolve.execute(h.system, {})).toEqual(
          ok({ resolved: 0, pending: 0, alerts: 1 }),
        );
        expect(h.alerts()).toEqual([{ kind: 'partial-match' }]);
      });

      it('runs from the job with the scheduler context', async () => {
        await h.leaveSending();
        pastLease();
        h.transferGateway.listAnswer = ok([h.stripeTransfer()]);
        const job = resolveTransfersJob(h.useCases.resolve);

        expect(job.name).toBe('payments.resolve-transfers');
        expect(job.every).toEqual(Temporal.Duration.from({ minutes: 5 }));
        await job.run(h.system as never);

        expect(h.row()!.state).toBe('executed');
      });
    });

    describe('transfer webhooks', () => {
      const deliverAndApply = async (event: Record<string, unknown>) => {
        const received = await h.deliver(event);
        const applied = await h.useCases.apply.execute(h.system, {});
        return { received, applied };
      };

      it('stores a transfer.created of this Market once and resolves a sending row', async () => {
        await h.leaveSending();
        h.transferGateway.readAnswer = ok(h.stripeTransfer());

        const { received, applied } = await deliverAndApply(transferEvent({ marketId: code }));

        expect(received).toEqual(ok('recorded'));
        expect(applied).toEqual(ok({ applied: 1, retried: 0, problems: [] }));
        expect(h.transferGateway.reads).toEqual(['tr_test_0001']);
        expect(h.row()).toMatchObject({ state: 'executed', providerTransferRef: 'tr_test_0001' });
        expect([...h.inbox.rows.values()][0]!.outcome).toBe('transfer-recorded');
        expect(await h.deliver(transferEvent({ marketId: code }))).toEqual(ok('duplicate'));
      });

      it('acknowledges and drops another Market, and refuses live mode', async () => {
        expect(await h.deliver(transferEvent({ marketId: 'QQ' }))).toEqual(ok('other-market'));
        expect(await h.deliver(transferEvent({ marketId: code, livemode: true }))).toEqual(
          err({ code: 'payments.event-refused' }),
        );
        expect(h.inbox.rows.size).toBe(0);
      });

      it('re-reads a transfer that carries no Market and rejects it without creating a row', async () => {
        h.transferGateway.readAnswer = ok(h.stripeTransfer({ marketId: null }));

        const { received, applied } = await deliverAndApply(transferEvent({ marketId: null }));

        expect(received).toEqual(ok('recorded'));
        expect(applied).toEqual(
          ok({
            applied: 1,
            retried: 0,
            problems: [{ eventId: 'evt_test_tr_0001', outcome: 'rejected' }],
          }),
        );
        expect(h.transfers.rows.size).toBe(0);
        expect(h.alerts()).toEqual([{ kind: 'transfer-unmatched' }]);
      });

      it('rejects a transfer for which no row is stored and creates none', async () => {
        h.transferGateway.readAnswer = ok(h.stripeTransfer());

        const { applied } = await deliverAndApply(transferEvent({ marketId: code }));

        expect(applied.ok && applied.value.problems).toHaveLength(1);
        expect(h.transfers.rows.size).toBe(0);
        expect(h.alerts()).toEqual([{ kind: 'transfer-unmatched' }]);
      });

      it('rejects a transfer whose amount differs from the row', async () => {
        await h.leaveSending();
        h.transferGateway.readAnswer = ok(h.stripeTransfer({ amountMinor: AMOUNT + 1n }));

        const { applied } = await deliverAndApply(transferEvent({ marketId: code }));

        expect(applied.ok && applied.value.problems).toHaveLength(1);
        expect(h.row()!.state).toBe('sending');
      });

      it('rejects a live-mode transfer read back from Stripe', async () => {
        await h.leaveSending();
        h.transferGateway.readAnswer = ok(h.stripeTransfer({ livemode: true }));

        const { applied } = await deliverAndApply(transferEvent({ marketId: code }));

        expect(applied.ok && applied.value.problems).toHaveLength(1);
        expect(h.row()!.state).toBe('sending');
      });

      it('retries when Stripe cannot be read', async () => {
        await h.leaveSending();
        h.transferGateway.readAnswer = err({ code: 'payment.provider-unavailable' });

        const { applied } = await deliverAndApply(transferEvent({ marketId: code }));

        expect(applied).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
        expect(h.row()!.state).toBe('sending');
      });

      it('records a fence breach on an abandoned row', async () => {
        await h.leaveSending();
        pastLease();
        await abandon();
        h.transferGateway.readAnswer = ok(h.stripeTransfer());

        await deliverAndApply(transferEvent({ marketId: code }));

        expect(h.row()).toMatchObject({ state: 'executed', fenceBreachedAt: h.clock.now() });
        expect(h.alerts()).toEqual([{ kind: 'fence-breached' }]);
      });

      it('records a reversal that only grows and never exceeds the amount', async () => {
        await h.ready();
        await h.useCases.instruct.execute(h.system, h.request());
        const reverse = async (id: string, amount: bigint) => {
          h.transferGateway.readAnswer = ok(h.stripeTransfer({ amountReversedMinor: amount }));
          return deliverAndApply(transferEvent({ id, type: 'transfer.reversed', marketId: code }));
        };

        await reverse('evt_test_tr_r1', 1000n);
        expect(h.row()!.reversedMinor).toBe(1000n);
        await reverse('evt_test_tr_r2', 400n);
        expect(h.row()!.reversedMinor).toBe(1000n);
        await reverse('evt_test_tr_r3', AMOUNT);
        expect(h.row()!.reversedMinor).toBe(AMOUNT);
        const over = await reverse('evt_test_tr_r4', AMOUNT + 1n);
        expect(over.applied.ok && over.applied.value.problems).toHaveLength(1);
        expect(h.row()!.reversedMinor).toBe(AMOUNT);
        expect(
          h.outbox.events.filter((e) => e.type === 'payments.transfer-changed.v1'),
        ).toHaveLength(3);
      });
    });

    describe('the connected account hash from a re-read', () => {
      const received = (
        type: 'account.updated' | 'account.external_account.created',
        id = 'evt_acct_1',
      ) => h.inbox.record(h.market, { eventId: id, type, objectId: ACCOUNT, receivedAt: T0 });

      it('stamps the hash of the default bank account the first time', async () => {
        await h.seedAccount({ externalAccountHmac: null });
        h.connect.readAnswer = ok(h.accountSnapshot());
        await received('account.updated');

        await h.useCases.apply.execute(h.system, {});

        expect(h.accounts.rows.get(h.accountKey)!.externalAccountHmac).toBe(h.hmacOf(EXTERNAL));
      });

      it('records a changed bank account found by any read as a change with its cooling-off', async () => {
        await h.seedAccount();
        h.connect.readAnswer = ok(h.accountSnapshot({ defaultExternalAccountId: 'ba_other' }));
        await received('account.updated');

        await h.useCases.apply.execute(h.system, {});

        expect(h.accounts.changes).toHaveLength(1);
        expect(h.accounts.changes[0]).toMatchObject({
          kind: 'updated',
          detectedBy: 'webhook',
          sourceEventId: 'evt_acct_1',
          externalAccountHmac: h.hmacOf('ba_other'),
        });
        expect(h.accounts.rows.get(h.accountKey)!.coolingOffUntil).not.toBeNull();
      });

      it('records an external-account event of a different bank account as a change, never the onboarding', async () => {
        await h.seedAccount({ lastChangeId: null });
        h.connect.readAnswer = ok(h.accountSnapshot({ defaultExternalAccountId: 'ba_other' }));
        await received('account.external_account.created');

        await h.useCases.apply.execute(h.system, {});

        expect(h.accounts.changes[0]).toMatchObject({
          kind: 'added',
          externalAccountHmac: h.hmacOf('ba_other'),
        });
        expect(h.accounts.rows.get(h.accountKey)!.coolingOffUntil).not.toBeNull();
      });

      it('re-stamps the same account under a newer key without a change', async () => {
        await h.seedAccount({ externalAccountHmac: h.hmacOf(EXTERNAL, 1) });
        h.connect.readAnswer = ok(h.accountSnapshot());
        (h.deps as { keyring: unknown }).keyring = testKeyring(undefined, 2);
        await received('account.updated');

        await h.useCases.apply.execute(h.system, {});

        expect(h.accounts.rows.get(h.accountKey)!.externalAccountHmac).toBe(h.hmacOf(EXTERNAL, 2));
        expect(h.accounts.changes).toHaveLength(0);
      });

      it('leaves a same hash alone', async () => {
        await h.seedAccount();
        h.connect.readAnswer = ok(h.accountSnapshot());
        await received('account.updated');

        await h.useCases.apply.execute(h.system, {});

        expect(h.accounts.rows.get(h.accountKey)!.externalAccountHmac).toBe(h.hmacOf(EXTERNAL));
        expect(h.accounts.changes).toHaveLength(0);
      });

      it('refuses to write a different value under the same key version without a change row', async () => {
        await h.seedAccount();
        const result = await h.accounts.stampExternalAccountHmac(
          h.market,
          SELLER,
          h.hmacOf(EXTERNAL),
          h.hmacOf('ba_other'),
        );
        expect(result).toBe('needs-change');
        expect(h.accounts.rows.get(h.accountKey)!.externalAccountHmac).toBe(h.hmacOf(EXTERNAL));
      });
    });

    describe('access and the facade', () => {
      it.each([
        [
          'instruct',
          (uc: typeof h.useCases, c: never) => uc.instruct.execute(c, h.request() as never),
        ],
        ['byKey', (uc: typeof h.useCases, c: never) => uc.byKey.execute(c, [KEY] as never)],
        ['abandon', (uc: typeof h.useCases, c: never) => uc.abandon.execute(c, KEY as never)],
        ['resolve', (uc: typeof h.useCases, c: never) => uc.resolve.execute(c, {})],
      ])('%s refuses every caller but the system', async (_name, run) => {
        await expectSystemOnly(code, (context) => run(h.useCases, context as never));
        expect(h.transferGateway.creates).toHaveLength(0);
        expect(h.transferGateway.lists).toHaveLength(0);
        expect(h.transfers.rows.size).toBe(0);
      });

      it('delegates to the use cases with the caller context', async () => {
        await h.ready();
        const facade = new PaymentsFacadeImplementation(
          undefined as never,
          undefined as never,
          h.useCases.instruct,
          h.useCases.byKey,
          h.useCases.abandon,
        );

        const sent = await facade.instructTransfer(h.system, h.request());
        const views = await facade.transferByKey(h.system, [KEY]);
        const abandoned = await facade.abandonTransfer(h.system, KEY);

        expect(sent.ok && sent.value.kind).toBe('accepted');
        expect(views.ok && views.value[0]!.state).toBe('executed');
        expect(abandoned.ok && abandoned.value.kind).toBe('already-sent');
        expect(OTHER_PAYOUT).not.toBe(PAYOUT);
      });
    });
  },
);
