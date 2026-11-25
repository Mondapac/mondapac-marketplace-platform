import type { Provider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import { CLOCK } from '../../clock/clock.module';
import { ID_GENERATOR } from '../../ids/ids.module';
import { PersistenceModule } from '../../persistence/persistence.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../unit-of-work/unit-of-work';
import { AiUsage } from '../usage/ai-usage';
import { AiEvaluationControl } from './evaluation-control';
import { AiEvaluationGateway } from './evaluation-gateway';
import { AiEvaluationRunner } from './evaluation-runner';
import { AI_EVALUATION_STORE, type AiEvaluationStore } from './evaluation-store';
import { EvaluationSuiteRegistry } from './evaluation-suite';

/**
 * The evaluation side of `platform/ai` (G4c), bound by `AiModule`: the suite registry, the store
 * (bound here only), the evaluation gateway (imported only inside `evaluations/`, boundary rule
 * ai-evaluation-gateway-only-from-evaluations), the runner of the job and settings' port.
 */
export const EVALUATION_PROVIDERS: readonly Provider[] = [
  EvaluationSuiteRegistry,
  PersistenceModule.aiEvaluationStore(),
  AiEvaluationGateway,
  {
    provide: AiEvaluationRunner,
    inject: [UNIT_OF_WORK, AI_EVALUATION_STORE, AiEvaluationGateway, CLOCK, ID_GENERATOR, AiUsage],
    useFactory: (
      unitOfWork: UnitOfWork,
      store: AiEvaluationStore,
      gateway: AiEvaluationGateway,
      clock: Clock,
      ids: IdGenerator,
      usage: AiUsage,
    ) =>
      new AiEvaluationRunner(unitOfWork, store, gateway, clock, ids, (market, at) =>
        usage.dayOf(market, at),
      ),
  },
  AiEvaluationControl,
];
