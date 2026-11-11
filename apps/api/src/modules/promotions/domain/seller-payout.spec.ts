import { sellerPayoutPreview } from './seller-payout';

describe('sellerPayoutPreview', () => {
  it('shows the design example: A$20.00, 15% off split 10% / 5%, commission 15%', () => {
    const p = sellerPayoutPreview({
      price: 2000n,
      reward: { kind: 'PERCENT', bps: 1500 },
      platformShareBps: 3334,
      commissionRateBps: 1500,
    });
    expect(p.discount).toBe(300n);
    expect(p.platformFunded).toBe(100n);
    expect(p.sellerFunded).toBe(200n);
    expect(p.shopperPays).toBe(1700n);
    expect(p.commissionBase).toBe(1800n);
    expect(p.commission).toBe(270n);
    expect(p.sellerGets).toBe(1530n);
  });

  it('a platform-funded discount leaves the seller the full share of the price', () => {
    const p = sellerPayoutPreview({
      price: 2000n,
      reward: { kind: 'PERCENT', bps: 1000 },
      platformShareBps: 10000,
      commissionRateBps: 1500,
    });
    expect(p.sellerFunded).toBe(0n);
    expect(p.commission).toBe(300n);
    expect(p.sellerGets).toBe(1700n);
    expect(p.shopperPays).toBe(1800n);
  });

  it('a seller-funded discount lowers the commission base', () => {
    const p = sellerPayoutPreview({
      price: 2000n,
      reward: { kind: 'PERCENT', bps: 1000 },
      platformShareBps: 0,
      commissionRateBps: 1500,
    });
    expect(p.commissionBase).toBe(1800n);
    expect(p.commission).toBe(270n);
    expect(p.sellerGets).toBe(1530n);
    expect(p.shopperPays).toBe(1800n);
  });

  it('rounds the commission half up, like the ledger', () => {
    const p = sellerPayoutPreview({
      price: 1005n,
      reward: null,
      platformShareBps: 0,
      commissionRateBps: 1000,
    });
    expect(p.commission).toBe(101n);
    expect(p.sellerGets).toBe(904n);
  });

  it('caps a fixed discount at the price', () => {
    const p = sellerPayoutPreview({
      price: 500n,
      reward: { kind: 'FIXED', amount: 900n },
      platformShareBps: 0,
      commissionRateBps: 1000,
    });
    expect(p.discount).toBe(500n);
    expect(p.shopperPays).toBe(0n);
    expect(p.sellerGets).toBe(0n);
  });

  it('adds up in every case', () => {
    for (const price of [1n, 7n, 999n, 123456n]) {
      for (const bps of [1, 333, 5000, 10000]) {
        for (const split of [0, 3333, 10000]) {
          const p = sellerPayoutPreview({
            price,
            reward: { kind: 'PERCENT', bps },
            platformShareBps: split,
            commissionRateBps: 1250,
          });
          expect(p.sellerFunded + p.platformFunded).toBe(p.discount);
          expect(p.shopperPays + p.discount).toBe(price);
          expect(p.commission + p.sellerGets).toBe(p.commissionBase);
        }
      }
    }
  });

  it('refuses a price below 1 and a rate out of range', () => {
    const base = { reward: null, platformShareBps: 0, commissionRateBps: 1000 };
    expect(() => sellerPayoutPreview({ ...base, price: 0n })).toThrow(RangeError);
    expect(() => sellerPayoutPreview({ ...base, price: 5n, commissionRateBps: 10001 })).toThrow(
      RangeError,
    );
  });
});
