import type { MarketId } from '@mondapac/shared-kernel';
import type { AiModelChoices } from '../../../platform/ai/model-choices';
import { AI_MODEL_TASKS, aiModelsCode, aiSaverCode, familiesOf } from '../domain/definitions';
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
