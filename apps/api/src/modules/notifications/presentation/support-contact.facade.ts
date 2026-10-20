import type { CallContext } from '@mondapac/shared-kernel';
import type { ViewPublicSupportContact } from '../application/use-cases/view-public-support-contact.use-case';
import type { SupportContactFacade } from '../contracts/support-contact.facade';

/** Passes the caller's `CallContext` unchanged to the public support contact, so the gate runs. */
export class SupportContactFacadeImplementation implements SupportContactFacade {
  constructor(private readonly view: ViewPublicSupportContact) {}

  async publicEmail(context: CallContext): Promise<string | null> {
    const result = await this.view.execute(context, {});
    return result.ok ? result.value.email : null;
  }
}
