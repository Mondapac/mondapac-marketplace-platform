import { Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';
import { capabilitySpecProblem, type CapabilitySpec } from './capability';

/** Registration refused at boot: an invalid spec, a foreign or duplicate id, or after sealing. */
export class CapabilityRegistryError extends Error {
  override readonly name = 'CapabilityRegistryError';
}

const OWNER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** The owner of the evaluation usage id `platform.ai-evaluation` (G4c); never a capability's. */
export const RESERVED_OWNER = 'platform';

/**
 * Every AI capability of the application (docs/design/domain/platform-ai.md section 4), like the
 * audit action catalogue. Modules register theirs at bootstrap with {@link registerCapabilities};
 * an invalid spec, an id that does not start with its owner, or a duplicate fails boot. Sealed when
 * the application has bootstrapped, in both roles. At run time an unknown capability is off.
 */
@Injectable()
export class CapabilityRegistry implements OnApplicationBootstrap {
  readonly #specs = new Map<string, CapabilitySpec>();
  #sealed = false;

  register(owner: string, specs: readonly CapabilitySpec[]): void {
    if (this.#sealed) throw new CapabilityRegistryError('The capability registry is sealed');
    if (typeof owner !== 'string' || !OWNER.test(owner)) {
      throw new CapabilityRegistryError('A capability owner is a module name');
    }
    // `platform.ai-evaluation` is the evaluation budget's usage id (G4c): no capability may be
    // counted under it, so `platform` registers none.
    if (owner === RESERVED_OWNER) {
      throw new CapabilityRegistryError('"platform" is reserved: it registers no capability');
    }
    for (const spec of specs) {
      const problem = capabilitySpecProblem(spec);
      if (problem !== null) {
        throw new CapabilityRegistryError(
          `"${owner}" registered an invalid capability: ${problem}`,
        );
      }
      if (!spec.id.startsWith(`${owner}.`)) {
        throw new CapabilityRegistryError(
          `"${owner}" cannot register "${spec.id}": a capability id starts with its owner`,
        );
      }
      if (this.#specs.has(spec.id)) {
        throw new CapabilityRegistryError(`The capability "${spec.id}" is registered twice`);
      }
      this.#specs.set(
        spec.id,
        Object.freeze({ ...spec, dataCategories: Object.freeze([...spec.dataCategories]) }),
      );
    }
  }

  seal(): void {
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  onApplicationBootstrap(): void {
    this.seal();
  }

  /** The spec of `id`, or `undefined` when no module registered it. */
  get(id: string): CapabilitySpec | undefined {
    return this.#specs.get(id);
  }

  /** Every registered id, sorted. */
  ids(): string[] {
    return [...this.#specs.keys()].sort();
  }
}

/** A provider that registers a module's capabilities when Nest builds the module. */
export function registerCapabilities(owner: string, specs: readonly CapabilitySpec[]): Provider {
  return {
    provide: Symbol(`ai-capabilities:${owner}`),
    inject: [CapabilityRegistry],
    useFactory: (registry: CapabilityRegistry) => {
      registry.register(owner, specs);
      return owner;
    },
  };
}
