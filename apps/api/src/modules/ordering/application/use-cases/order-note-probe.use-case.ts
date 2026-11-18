import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_NOTE } from '../../contracts/permissions';

// A probe of the order lists (super list phase 1): it asks the gate whether the caller holds one
// key, and reads and writes nothing. `access.denied` means "no". The lists call it to name the row
// actions the caller may run (the row Actions menu); the action checks its key again when it runs.

type Held = { readonly held: true };
type Denied = { readonly code: 'access.denied' };

/** `ordering.order-note-probe`: the key `ordering.order.note` (admin note). */
export class OrderNoteProbe extends UseCase<Record<string, never>, Held, Denied> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.order-note-probe',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_NOTE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<Held, Denied>> {
    return Promise.resolve(ok({ held: true }));
  }
}
