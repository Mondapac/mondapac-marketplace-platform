import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from './access-denied';
import { accessDeclarationOf, type AccessDeclaration } from './access-rule';
import { UseCaseGate } from './use-case-gate';

/** A use-case class that breaks the rules of identity design 5.2 (HF4): refused at boot. */
export class UseCaseDefinitionError extends Error {
  override readonly name = 'UseCaseDefinitionError';
}

/**
 * The base class of every use case (identity design 5.2; platform-foundations design 6.4). A
 * use case is a class in `modules/<m>/application/use-cases/<name>.use-case.ts` that extends
 * this class directly and carries its rule as an own static property:
 *
 * ```ts
 * export class PurgeExpired extends UseCase<PurgeInput, PurgeOutput> {
 *   static override readonly access: AccessDeclaration = {
 *     name: 'identity.purge-expired',
 *     rule: { kind: 'system' },
 *   };
 *   constructor(gate: UseCaseGate, private readonly sessions: SessionRepository) {
 *     super(gate);
 *   }
 *   protected async handle(context: CallContext, input: PurgeInput) { ... }
 * }
 * ```
 *
 * `execute` is the only public entry: it asks the {@link UseCaseGate} and only then calls
 * `handle`, which checks ownership (R6) and opens its own unit of work (platform persistence
 * 3.4). The constructor refuses, so boot fails, a class that does not extend `UseCase`
 * directly, overrides `execute`, or has no valid declaration of its own; the CI check refuses
 * the same in source, and the gate checks the declaration again on every call.
 */
export abstract class UseCase<Input, Output, Failure = never> {
  /** Declared by every concrete subclass as its own property; never inherited (HF4). */
  declare static readonly access: AccessDeclaration;

  readonly #gate: UseCaseGate;
  /** The concrete class, captured at construction: the gate reads its own `access`. */
  readonly #useCase: object;

  protected constructor(gate: UseCaseGate) {
    if (!(gate instanceof UseCaseGate)) {
      throw new UseCaseDefinitionError('A use case is constructed with the platform UseCaseGate');
    }
    const useCase = new.target;
    if (Object.getPrototypeOf(useCase) !== UseCase) {
      throw new UseCaseDefinitionError(
        `${useCase.name} must extend UseCase directly; a use case never extends another one`,
      );
    }
    if (Object.hasOwn(useCase.prototype, 'execute')) {
      throw new UseCaseDefinitionError(`${useCase.name} overrides execute, the gate's entry`);
    }
    const declared = accessDeclarationOf(useCase);
    if (!declared.ok) {
      throw new UseCaseDefinitionError(
        `${useCase.name} has no valid access declaration of its own (${declared.error.code})`,
      );
    }
    this.#gate = gate;
    this.#useCase = useCase;
  }

  /** The only public entry: the gate first, then `handle` with the context it admitted. */
  async execute(
    context: CallContext,
    input: Input,
  ): Promise<Result<Output, AccessDenied | Failure>> {
    const admitted = await this.#gate.admit(this.#useCase, context);
    if (!admitted.ok) return admitted;
    return this.handle(admitted.value, input);
  }

  /**
   * The body. Called by `execute` only, after admission, with the admitted context: under an
   * `anonymous` rule its actor is always the Market's anonymous actor (HF9).
   */
  protected abstract handle(context: CallContext, input: Input): Promise<Result<Output, Failure>>;
}
