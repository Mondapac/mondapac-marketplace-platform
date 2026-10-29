import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AdminBalanceOf } from '../application/use-cases/admin-balance-of.use-case';
import type { BalanceOf } from '../application/use-cases/balance-of.use-case';
import type { CaptureHold } from '../application/use-cases/capture-hold.use-case';
import type { GrantCredit } from '../application/use-cases/grant-credit.use-case';
import type { OwnBalanceOf } from '../application/use-cases/own-balance-of.use-case';
import type { PlaceHold } from '../application/use-cases/place-hold.use-case';
import type { ReleaseHold } from '../application/use-cases/release-hold.use-case';
import type {
  GrantCreditRequest,
  PlaceHoldRequest,
  SettleHoldRequest,
  WalletFacade,
} from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class WalletFacadeImplementation implements WalletFacade {
  constructor(
    private readonly grant: GrantCredit,
    private readonly place: PlaceHold,
    private readonly capture: CaptureHold,
    private readonly release: ReleaseHold,
    private readonly balance: BalanceOf,
    private readonly ownBalance: OwnBalanceOf,
    private readonly adminBalance: AdminBalanceOf,
  ) {}

  grantCredit(context: CallContext, request: GrantCreditRequest) {
    return this.grant.execute(context, request);
  }

  placeHold(context: CallContext, request: PlaceHoldRequest) {
    return this.place.execute(context, request);
  }

  captureHold(context: CallContext, request: SettleHoldRequest) {
    return this.capture.execute(context, request);
  }

  releaseHold(context: CallContext, request: SettleHoldRequest) {
    return this.release.execute(context, request);
  }

  balanceOf(context: CallContext, customerAccountId: Id<'Account'>) {
    return this.balance.execute(context, { customerAccountId });
  }

  adminBalanceOf(context: CallContext, customerAccountId: Id<'Account'>) {
    return this.adminBalance.execute(context, { customerAccountId });
  }

  ownBalanceOf(context: CallContext) {
    return this.ownBalance.execute(context, {});
  }
}
