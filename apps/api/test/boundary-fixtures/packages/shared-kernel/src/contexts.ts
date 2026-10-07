// A stand-in for the kernel's `contexts` entry (actor and CallContext constructors and
// types), which does not exist on main yet. tsconfig.json maps @mondapac/shared-kernel/contexts
// here, so the fixtures resolve without the real entry.
export type ActorContext = AnonymousActor | SystemActor | AuthenticatedActor;
export interface AnonymousActor {
  readonly kind: 'anonymous';
}
export interface SystemActor {
  readonly kind: 'system';
}
export interface AuthenticatedActor {
  readonly kind: 'authenticated';
}
export interface CallContext {
  readonly actor: ActorContext;
}
export const anonymousActor = (): AnonymousActor => ({ kind: 'anonymous' });
export const systemActor = (): SystemActor => ({ kind: 'system' });
export const createCallContext = (actor: ActorContext): CallContext => ({ actor });
