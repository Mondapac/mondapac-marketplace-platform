import { Logger } from '@nestjs/common';
import { isLiveStripeKey, UnwiredPayoutPrerequisites } from './unwired-payout-prerequisites';

describe('the unwired payout prerequisites', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('says ok in test mode, as the brief allows', async () => {
    await expect(new UnwiredPayoutPrerequisites(false).check()).resolves.toBe('ok');
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails closed against the live provider, and says so once at construction', async () => {
    const adapter = new UnwiredPayoutPrerequisites(true);
    await expect(adapter.check()).resolves.toBe('unavailable');
    await expect(adapter.check()).resolves.toBe('unavailable');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sk_test_abcdefgh12345678', false],
    ['rk_test_abcdefgh12345678', false],
    [null, false],
    ['sk_live_abcdefgh12345678', true],
    ['rk_live_abcdefgh12345678', true],
    ['anything-else', true],
  ])('reads %s as live: %s', (key, live) => {
    expect(isLiveStripeKey(key)).toBe(live);
  });
});
