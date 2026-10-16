import { Injectable, type Provider } from '@nestjs/common';

const MODULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTION_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){1,3}$/;

/** A sensitive seller action that can ask for a fresh two-step code (seller OTP policy). */
export interface StepUpActionDeclaration {
  /** `<module>.<noun>.<verb>`; the first segment is the registering module. */
  readonly key: string;
  /** Whether the action asks for a code when the seller has set no rule of its own. */
  readonly defaultRequired: boolean;
  /** The platform floor: always required, the seller cannot turn it off. */
  readonly locked: boolean;
}

export class StepUpRegistryError extends Error {
  override readonly name = 'StepUpRegistryError';
}

/**
 * The code catalogue of step-up actions (seller OTP policy proposal, 2026-10-16). Each module
 * pushes its actions at bootstrap with {@link registerStepUpActions}, as it does permissions; the
 * policy screen lists only registered keys. Boot fails on a duplicate or malformed key, a key
 * whose first segment is not the registering module, and a locked action that is not required by
 * default. It holds the catalogue only: no seller rule, no database.
 */
@Injectable()
export class StepUpActionRegistry {
  readonly #actions = new Map<string, StepUpActionDeclaration>();

  register(module: string, actions: readonly StepUpActionDeclaration[]): void {
    if (!MODULE_NAME.test(module)) throw new StepUpRegistryError(`Malformed module "${module}"`);
    for (const action of actions) {
      if (!ACTION_KEY.test(action.key)) {
        throw new StepUpRegistryError(`Malformed step-up action key "${action.key}"`);
      }
      if (action.key.split('.')[0] !== module) {
        throw new StepUpRegistryError(`Step-up action "${action.key}" is not ${module}'s`);
      }
      if (action.locked && !action.defaultRequired) {
        throw new StepUpRegistryError(`Locked step-up action "${action.key}" must be required`);
      }
      if (this.#actions.has(action.key)) {
        throw new StepUpRegistryError(`Step-up action "${action.key}" is declared twice`);
      }
      this.#actions.set(action.key, Object.freeze({ ...action }));
    }
  }

  get(key: string): StepUpActionDeclaration | undefined {
    return this.#actions.get(key);
  }

  /** Every action, sorted by key. */
  list(): readonly StepUpActionDeclaration[] {
    return [...this.#actions.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

/**
 * The line of a module's Nest module that registers its step-up actions:
 * `providers: [registerStepUpActions('pricing', PRICING_STEP_UP_ACTIONS)]`.
 */
export function registerStepUpActions(
  module: string,
  actions: readonly StepUpActionDeclaration[],
): Provider {
  return {
    provide: Symbol(`step-up-actions:${module}`),
    inject: [StepUpActionRegistry],
    useFactory: (registry: StepUpActionRegistry) => {
      registry.register(module, actions);
      return module;
    },
  };
}
