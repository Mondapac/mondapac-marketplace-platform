import { Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';
import { CapabilityRegistry, RESERVED_OWNER } from '../capability-registry';
import type { ModelRequest, ModelTurn } from '../model-provider';
import type { OutputCheck } from '../usage/ai-usage-store';

export type { OutputCheck } from '../usage/ai-usage-store';

/**
 * The checks a suite grades an answer with (G4c; docs/design/domain/platform-ai.md section 8, Tab
 * 1, Evaluation): closed codes, the only thing stored about an answer (no model text is kept).
 * `leak`: text the case must never show reached the shown text (a certification claim, a contact
 * detail ...); `empty`: nothing was left to show; `incomplete`: the model did not end its turn with
 * text alone; `too-long`: it stopped at its output cap; `missing-fact`: a fact the case must keep
 * was dropped.
 */
export const EVALUATION_CHECKS = [
  'leak',
  'empty',
  'incomplete',
  'too-long',
  'missing-fact',
] as const;
export type EvaluationCheck = (typeof EVALUATION_CHECKS)[number];

export interface EvaluationGrade {
  readonly passed: boolean;
  /** The failed checks, each once; empty when passed. */
  readonly checks: readonly EvaluationCheck[];
}

/**
 * A capability's synthetic evaluation set as `platform/ai` runs it (ADR-0019 decision 9; G4c).
 * Declared by the owning module in its `contracts/ai-evaluation-suites.ts`, built from its own
 * evaluation set, its real prompt builder and its own guard, and registered from its module file
 * with {@link registerEvaluationSuites}. Types and registration only: this file calls no model.
 *
 * Every sample is synthetic (no customer, seller or product of any Market). The gateway sends only
 * what `request` builds, with no tools: G4c runs capabilities without tool rounds (the buyer chat,
 * which uses tools, waits for G4c2).
 */
export interface EvaluationSuite {
  /** The registered capability, `<owner>.<name>`, with no tool rounds. */
  readonly capability: string;
  /** The evaluation set's version; a pass candidate is bound to it and the prompt version. */
  readonly setVersion: string;
  /** Every sample id, in the order a run takes them. */
  sampleIds(): readonly string[];
  /** A plain-text summary of the sample's synthetic input for the playground list; null: unknown. */
  label(sampleId: string): string | null;
  /** The capability's real request for the sample (its prompt builder), `tools: []`; null: unknown. */
  request(sampleId: string): ModelRequest | null;
  /** The sample's grade of an answer, with the capability's own guard. */
  grade(sampleId: string, turn: ModelTurn): EvaluationGrade;
  /**
   * What the capability would show of the answer, after its own guard: inert plain text (no HTML,
   * links or images, R9), or null when it would show nothing. Only the playground returns it; a
   * run never stores it.
   */
  display(sampleId: string, turn: ModelTurn): string | null;
  /**
   * The capability's own check of a real caller's answer, for a shadow sample (G6c; design section
   * 6, "Shadow mode"): `valid` when the capability would use it, `invalid` when it would not (no text
   * alone, nothing left after its guard), `guard-rejected` when its guard took out a certification
   * claim. `request` is the request as sent (masked). Pure and deterministic: nothing of the answer is
   * kept or shown, only this result. A capability without it is never sent to shadow, since its
   * rates could not be compared.
   */
  shadow?(request: ModelRequest, turn: ModelTurn): OutputCheck;
}

/** Registration refused at boot (an unknown or foreign capability, tools, a duplicate, sealed). */
export class EvaluationSuiteRegistryError extends Error {
  override readonly name = 'EvaluationSuiteRegistryError';
}

const OWNER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A sample id as runs and the playground carry it (stored, sent by the browser). */
export const SAMPLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Every evaluation suite of the application, like the capability registry: modules register at
 * bootstrap, and the registry is sealed when the application has bootstrapped, in both roles. A
 * suite is refused for a capability its owner did not register, one with tool rounds, a second
 * suite of a capability, a sample id outside {@link SAMPLE_ID} or a sample whose request is
 * missing or carries tools; the capability checks run at seal, when every module has registered.
 */
@Injectable()
export class EvaluationSuiteRegistry implements OnApplicationBootstrap {
  readonly #suites = new Map<string, EvaluationSuite>();
  #sealed = false;

  constructor(private readonly capabilities: CapabilityRegistry) {}

  register(owner: string, suites: readonly EvaluationSuite[]): void {
    if (this.#sealed) throw new EvaluationSuiteRegistryError('The evaluation registry is sealed');
    if (typeof owner !== 'string' || !OWNER.test(owner) || owner === RESERVED_OWNER) {
      throw new EvaluationSuiteRegistryError('An evaluation suite owner is a module name');
    }
    for (const suite of suites) {
      if (typeof suite.capability !== 'string' || !suite.capability.startsWith(`${owner}.`)) {
        throw new EvaluationSuiteRegistryError(
          `"${owner}" cannot register a suite of "${String(suite.capability)}"`,
        );
      }
      if (this.#suites.has(suite.capability)) {
        throw new EvaluationSuiteRegistryError(`"${suite.capability}" has two evaluation suites`);
      }
      if (typeof suite.setVersion !== 'string' || !VERSION.test(suite.setVersion)) {
        throw new EvaluationSuiteRegistryError(`"${suite.capability}": invalid set version`);
      }
      const ids = suite.sampleIds();
      if (ids.length === 0 || new Set(ids).size !== ids.length) {
        throw new EvaluationSuiteRegistryError(`"${suite.capability}": samples are distinct ids`);
      }
      for (const id of ids) {
        if (!SAMPLE_ID.test(id)) {
          throw new EvaluationSuiteRegistryError(`"${suite.capability}": invalid sample id`);
        }
        const request = suite.request(id);
        if (request === null || request.tools.length > 0) {
          throw new EvaluationSuiteRegistryError(
            `"${suite.capability}" sample "${id}": a request without tools is required`,
          );
        }
      }
      this.#suites.set(suite.capability, suite);
    }
  }

  /** Checks every suite against the capability registry, then seals. */
  seal(): void {
    for (const capability of this.#suites.keys()) {
      const spec = this.capabilities.get(capability);
      if (spec === undefined) {
        throw new EvaluationSuiteRegistryError(`"${capability}" is not a registered capability`);
      }
      if (spec.maxToolRounds > 0) {
        throw new EvaluationSuiteRegistryError(
          `"${capability}" uses tools: its evaluation waits for G4c2`,
        );
      }
    }
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  onApplicationBootstrap(): void {
    this.seal();
  }

  /** The suite of a capability, or undefined. */
  get(capability: string): EvaluationSuite | undefined {
    return this.#suites.get(capability);
  }

  /** Every capability with a suite, sorted. */
  ids(): string[] {
    return [...this.#suites.keys()].sort();
  }
}

/** A provider that registers a module's evaluation suites when Nest builds the module. */
export function registerEvaluationSuites(
  owner: string,
  suites: readonly EvaluationSuite[],
): Provider {
  return {
    provide: Symbol(`ai-evaluation-suites:${owner}`),
    inject: [EvaluationSuiteRegistry],
    useFactory: (registry: EvaluationSuiteRegistry) => {
      registry.register(owner, suites);
      return owner;
    },
  };
}
