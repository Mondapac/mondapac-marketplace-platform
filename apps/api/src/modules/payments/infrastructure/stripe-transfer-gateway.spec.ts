import { StripeTransferApiGateway, type TransferRequestFn } from './stripe-transfer-gateway';

// The transfers gateway against a fake `fetch`: the exact create request (form body, idempotency
// key, no description, the secret only in Authorization), the three answers, the group lookup that
// never says "not found" from an incomplete page, and every failure as a code.

const KEY = 'sk_test_abcdefgh12345678';
const PAYOUT = '01990000-0000-7000-8000-0000000000e1';
const respond =
  (status: number, body: unknown): TransferRequestFn =>
  () =>
    Promise.resolve({ status, json: () => Promise.resolve(body) });

const TRANSFER = {
  id: 'tr_test_1',
  object: 'transfer',
  livemode: false,
  amount: 5000,
  currency: 'aud',
  destination: 'acct_test_a1',
  amount_reversed: 0,
  transfer_group: PAYOUT,
  metadata: { mp_key: 'payout-1', payout_id: PAYOUT, market_id: 'AU' },
  description: 'Should not be kept',
};
const REQUEST = {
  destination: 'acct_test_a1',
  amountMinor: 5000n,
  currency: 'AUD',
  transferGroup: PAYOUT,
  key: 'payout-1',
  payoutId: PAYOUT,
  marketId: 'AU',
};

describe('StripeTransferApiGateway', () => {
  describe('createTransfer', () => {
    it('sends one form with the idempotency key and no description, and answers created', async () => {
      const calls: Parameters<TransferRequestFn>[] = [];
      const gateway = new StripeTransferApiGateway(KEY, (url, init) => {
        calls.push([url, init]);
        return respond(200, TRANSFER)(url, init);
      });

      expect(await gateway.createTransfer(REQUEST)).toEqual({ kind: 'created', ref: 'tr_test_1' });

      expect(calls).toHaveLength(1);
      const [url, init] = calls[0]!;
      expect(url).toBe('https://api.stripe.com/v1/transfers');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': 'payout-1',
      });
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        amount: '5000',
        currency: 'aud',
        destination: 'acct_test_a1',
        transfer_group: PAYOUT,
        'metadata[mp_key]': 'payout-1',
        'metadata[payout_id]': PAYOUT,
        'metadata[market_id]': 'AU',
      });
      expect(init.body).not.toContain(KEY);
    });

    it.each([
      [
        400,
        { error: { code: 'balance_insufficient', message: 'secret text' } },
        'insufficient-balance',
      ],
      [402, { error: { code: 'card_declined' } }, 'provider-refused'],
      [403, { error: { code: 'permission' } }, 'provider-refused'],
      [404, 'not json at all', 'provider-refused'],
    ])(
      'answers refused for a %s (a definite refusal, nothing created)',
      async (status, body, code) => {
        const gateway = new StripeTransferApiGateway(KEY, respond(status, body));
        expect(await gateway.createTransfer(REQUEST)).toEqual({ kind: 'refused', code });
      },
    );

    it.each([409, 429, 500, 502, 503])(
      'answers unknown for a %s: the transfer may exist',
      async (status) => {
        const gateway = new StripeTransferApiGateway(KEY, respond(status, {}));
        expect(await gateway.createTransfer(REQUEST)).toEqual({ kind: 'unknown' });
      },
    );

    it('answers unknown for a lost connection, a timeout and an answer that is not our transfer', async () => {
      const failing = new StripeTransferApiGateway(KEY, () => Promise.reject(new Error('reset')));
      expect(await failing.createTransfer(REQUEST)).toEqual({ kind: 'unknown' });
      const hanging = new StripeTransferApiGateway(
        KEY,
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
        10,
      );
      expect(await hanging.createTransfer(REQUEST)).toEqual({ kind: 'unknown' });
      expect(
        await new StripeTransferApiGateway(KEY, respond(200, { id: 'x' })).createTransfer(REQUEST),
      ).toEqual({ kind: 'unknown' });
      // A 200 for another key is not this transfer.
      const other = { ...TRANSFER, metadata: { mp_key: 'payout-2' } };
      expect(
        await new StripeTransferApiGateway(KEY, respond(200, other)).createTransfer(REQUEST),
      ).toEqual({ kind: 'unknown' });
    });

    it('sends nothing without a key or for a request Stripe would refuse anyway', async () => {
      const calls: string[] = [];
      const record: TransferRequestFn = (url, init) => {
        calls.push(url);
        return respond(200, TRANSFER)(url, init);
      };
      const none = new StripeTransferApiGateway(null, record);
      expect(none.available()).toBe(false);
      expect(await none.createTransfer(REQUEST)).toMatchObject({ kind: 'refused' });
      const gateway = new StripeTransferApiGateway(KEY, record);
      expect(gateway.available()).toBe(true);
      for (const change of [
        { destination: 'not_an_account' },
        { amountMinor: 0n },
        { currency: 'aud' },
        { key: 'has space' },
        { payoutId: 'nope' },
        { transferGroup: 'nope' },
        { marketId: 'au' },
      ]) {
        expect(await gateway.createTransfer({ ...REQUEST, ...change })).toMatchObject({
          kind: 'refused',
        });
      }
      expect(calls).toEqual([]);
    });
  });

  describe('listTransfersByGroup', () => {
    const list = (data: unknown[], hasMore = false) => ({
      object: 'list',
      data,
      has_more: hasMore,
    });

    it('reads one page of the group and keeps only what is matched on', async () => {
      const calls: string[] = [];
      const gateway = new StripeTransferApiGateway(KEY, (url, init) => {
        calls.push(`${init.method} ${url}`);
        return respond(200, list([TRANSFER]))(url, init);
      });

      const found = await gateway.listTransfersByGroup(PAYOUT);

      expect(calls).toEqual([
        `GET https://api.stripe.com/v1/transfers?transfer_group=${PAYOUT}&limit=100`,
      ]);
      expect(found).toEqual({
        ok: true,
        value: [
          {
            id: 'tr_test_1',
            livemode: false,
            amountMinor: 5000n,
            currency: 'aud',
            destination: 'acct_test_a1',
            amountReversedMinor: 0n,
            key: 'payout-1',
            marketId: 'AU',
          },
        ],
      });
    });

    it('is a failure, never an empty answer, when the page may not hold every transfer', async () => {
      const more = new StripeTransferApiGateway(KEY, respond(200, list([TRANSFER], true)));
      expect(await more.listTransfersByGroup(PAYOUT)).toMatchObject({ ok: false });
      const noFlag = new StripeTransferApiGateway(KEY, respond(200, { object: 'list', data: [] }));
      expect(await noFlag.listTransfersByGroup(PAYOUT)).toMatchObject({ ok: false });
      const malformed = new StripeTransferApiGateway(KEY, respond(200, list([{ id: 'tr_x' }])));
      expect(await malformed.listTransfersByGroup(PAYOUT)).toMatchObject({ ok: false });
    });

    it.each([
      [500, 'payment.provider-unavailable'],
      [429, 'payment.provider-unavailable'],
      [404, 'payment.provider-rejected'],
    ])('fails with a code for a %s, without Stripe text', async (status, code) => {
      const gateway = new StripeTransferApiGateway(
        KEY,
        respond(status, { error: { message: 'x' } }),
      );
      expect(await gateway.listTransfersByGroup(PAYOUT)).toEqual({ ok: false, error: { code } });
    });

    it('refuses a group that is not a payout id, and has no key to look up with', async () => {
      const gateway = new StripeTransferApiGateway(KEY, respond(200, list([])));
      expect(await gateway.listTransfersByGroup('a&b=c')).toMatchObject({ ok: false });
      const none = new StripeTransferApiGateway(null, respond(200, list([])));
      expect(await none.listTransfersByGroup(PAYOUT)).toMatchObject({ ok: false });
    });
  });

  describe('readTransfer', () => {
    it('reads one transfer by id', async () => {
      const calls: string[] = [];
      const gateway = new StripeTransferApiGateway(KEY, (url, init) => {
        calls.push(`${init.method} ${url}`);
        return respond(200, { ...TRANSFER, amount_reversed: 1200 })(url, init);
      });
      const read = await gateway.readTransfer('tr_test_1');
      expect(calls).toEqual(['GET https://api.stripe.com/v1/transfers/tr_test_1']);
      expect(read.ok && read.value.amountReversedMinor).toBe(1200n);
      expect(read.ok && read.value.livemode).toBe(false);
    });

    it('fails with a code for a bad id, an unavailable Stripe and a malformed transfer', async () => {
      const gateway = new StripeTransferApiGateway(KEY, respond(200, TRANSFER));
      expect(await gateway.readTransfer('ch_1')).toEqual({
        ok: false,
        error: { code: 'payment.provider-rejected' },
      });
      const down = new StripeTransferApiGateway(KEY, respond(503, {}));
      expect(await down.readTransfer('tr_test_1')).toEqual({
        ok: false,
        error: { code: 'payment.provider-unavailable' },
      });
      const odd = new StripeTransferApiGateway(KEY, respond(200, { ...TRANSFER, amount: 'x' }));
      expect(await odd.readTransfer('tr_test_1')).toMatchObject({ ok: false });
    });
  });
});
