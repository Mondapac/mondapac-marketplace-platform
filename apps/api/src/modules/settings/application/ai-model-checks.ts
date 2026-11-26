import type { MarketId } from '@mondapac/shared-kernel';
import type { AiModelChoices } from '../../../platform/ai/model-choices';
import {
  AI_MODEL_TASKS,
  aiInHouseModelCode,
  aiInHouseRolloutCode,
  aiInHouseShadowCode,
  aiInHouseStageCode,
  aiModelsCode,
  aiSaverCode,
  familiesOf,
  type AiInHouseStage,
} from '../domain/definitions';
import type { FieldIssue } from './settings-flow';

/**
 * The server checks of the External models tab (G4b) on the page as it would stand, for each task
 * type whose list or saver model changes; a panel revert runs them too (G4d3).
 */
export function aiModelIssues(
  choices: Pick<AiModelChoices, 'check'>,
  marketId: MarketId,
  values: ReadonlyMap<string, string>,
  changed: ReadonlySet<string>,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const task of AI_MODEL_TASKS) {
    const listCode = aiModelsCode(task);
    const saverCode = aiSaverCode(task);
    const listChanged = changed.has(listCode);
    if (!listChanged && !changed.has(saverCode)) continue;
    const list = familiesOf(values.get(listCode)!);
    const saver = familiesOf(values.get(saverCode)!)[0] ?? null;
    const check = choices.check(marketId, task, list, saver);
    if (listChanged) {
      check.list.forEach((problem, index) => {
        if (problem !== null) issues.push({ path: `${listCode}.${index}`, code: problem });
      });
    }
    if (check.saver !== null) issues.push({ path: saverCode, code: check.saver });
  }
  return issues;
}

/**
 * The server checks of the Mondapac Intelligence tab (G6b) on the page as it would stand, for each
 * task type whose stage, in-house model or share changes; a panel revert runs them too. A problem
 * is reported on the field it belongs to: the stage, the model or the stage's own share. The
 * rollback limits have only their definition's bounds (the server ceiling and the sample floor).
 */
export function aiInHouseIssues(
  choices: Pick<AiModelChoices, 'checkInHouse'>,
  marketId: MarketId,
  values: ReadonlyMap<string, string>,
  changed: ReadonlySet<string>,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const task of AI_MODEL_TASKS) {
    const codes = {
      stage: aiInHouseStageCode(task),
      family: aiInHouseModelCode(task),
      shadowPercent: aiInHouseShadowCode(task),
      rolloutPercent: aiInHouseRolloutCode(task),
    } as const;
    if (!Object.values(codes).some((code) => changed.has(code))) continue;
    // `values` holds the value in force of every code (a stored value its definition does not
    // allow is already its safe value: stage off, no model, share 0), so the casts are safe.
    const check = choices.checkInHouse(marketId, task, {
      stage: values.get(codes.stage) as AiInHouseStage,
      family: familiesOf(values.get(codes.family)!)[0] ?? null,
      shadowPercent: Number(values.get(codes.shadowPercent)),
      rolloutPercent: Number(values.get(codes.rolloutPercent)),
    });
    for (const field of ['stage', 'family', 'shadowPercent', 'rolloutPercent'] as const) {
      const problem = check[field];
      if (problem !== null) issues.push({ path: codes[field], code: problem });
    }
  }
  return issues;
}
