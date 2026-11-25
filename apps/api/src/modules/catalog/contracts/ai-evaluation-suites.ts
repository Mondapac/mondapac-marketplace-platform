import type {
  EvaluationCheck,
  EvaluationGrade,
  EvaluationSuite,
} from '../../../platform/ai/evaluations/evaluation-suite';
import type { ModelRequest, ModelTurn } from '../../../platform/ai/model-provider';
import { draftText, guardDraft } from '../domain/description-writer/draft-guard';
import {
  WRITER_EVALUATION_SET,
  WRITER_EVALUATION_VERSION,
  type WriterEvaluationCase,
} from '../domain/description-writer/evaluation-set';
import {
  WRITER_MAX_OUTPUT_TOKENS,
  writerFacts,
  writerInput,
  writerInstructions,
} from '../domain/description-writer/writer-prompt';
import {
  parseWriterRequest,
  type WriterRequest,
} from '../domain/description-writer/writer-request';
import { DESCRIPTION_WRITER_ADMIN, DESCRIPTION_WRITER_SELLER } from './ai-capabilities';

/**
 * catalog's evaluation suites (AI Gateway G4c; docs/design/domain/platform-ai.md section 8, Tab 1,
 * Evaluation and Playground): the description writer's synthetic evaluation set, sent through the
 * writer's real prompt builder and graded with its own draft guard. One suite per capability (the
 * seller's and the admin's writer share the prompt and the set). Every input is the set's
 * synthetic form data; nothing of a seller, a product or a Market is sent.
 *
 * Grading: the answer must end its turn with text alone (`incomplete`, or `too-long` at the output
 * cap); after the guard, nothing of the case's `mustNotShow` may remain (`leak`: a certification
 * claim, a ruling, a contact detail ...), something must remain (`empty`), and every `mustShow` must
 * stay (`missing-fact`). The Market's claim vocabulary (an application port) is not run here: the
 * guard is the deterministic part, and a leak it lets through fails the sample.
 */

const CASES: ReadonlyMap<string, WriterEvaluationCase> = new Map(
  WRITER_EVALUATION_SET.map((item) => [item.id, item]),
);

/** The case's form data as the modal would send it, with the modal's default tone and length. */
function requestOf(item: WriterEvaluationCase): WriterRequest | null {
  const parsed = parseWriterRequest(item.input);
  return parsed.ok ? parsed.value : null;
}

/** The answer's text when the model ended its turn with text alone; else null. */
function textOf(turn: ModelTurn): string | null {
  if (turn.stop !== 'end' || turn.blocks.some((block) => block.type !== 'text')) return null;
  return turn.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** What the writer's modal would put into the field: the guard's kept sentences. */
function shown(item: WriterEvaluationCase, request: WriterRequest, text: string): string {
  return draftText(guardDraft(text, writerFacts(request)).sentences);
}

function grade(item: WriterEvaluationCase | undefined, turn: ModelTurn): EvaluationGrade {
  const request = item === undefined ? null : requestOf(item);
  if (item === undefined || request === null) return { passed: false, checks: ['incomplete'] };
  const text = textOf(turn);
  if (text === null) {
    return { passed: false, checks: [turn.stop === 'max-tokens' ? 'too-long' : 'incomplete'] };
  }
  const kept = shown(item, request, text);
  const lower = kept.toLowerCase();
  const checks: EvaluationCheck[] = [];
  if (kept.trim().length === 0) checks.push('empty');
  if (item.mustNotShow.some((word) => lower.includes(word.toLowerCase()))) checks.push('leak');
  if ((item.mustShow ?? []).some((word) => !lower.includes(word.toLowerCase()))) {
    checks.push('missing-fact');
  }
  return { passed: checks.length === 0, checks };
}

function writerSuite(capability: string): EvaluationSuite {
  return {
    capability,
    setVersion: WRITER_EVALUATION_VERSION,
    sampleIds: () => WRITER_EVALUATION_SET.map((item) => item.id),
    label: (sampleId) => {
      const item = CASES.get(sampleId);
      if (item === undefined) return null;
      const { title, category, keywords, note } = item.input;
      const parts = [`${title} (${category})`];
      if (keywords !== undefined && keywords.length > 0)
        parts.push(`keywords: ${keywords.join(', ')}`);
      if (note !== undefined) parts.push(`note: ${note}`);
      return parts.join('; ');
    },
    request: (sampleId): ModelRequest | null => {
      const item = CASES.get(sampleId);
      const request = item === undefined ? null : requestOf(item);
      if (request === null) return null;
      return {
        system: writerInstructions(request.tone, request.length),
        messages: [{ role: 'user', blocks: [{ type: 'text', text: writerInput(request) }] }],
        tools: [],
        maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
      };
    },
    grade: (sampleId, turn) => grade(CASES.get(sampleId), turn),
    display: (sampleId, turn) => {
      const item = CASES.get(sampleId);
      const request = item === undefined ? null : requestOf(item);
      const text = textOf(turn);
      if (item === undefined || request === null || text === null) return null;
      const kept = shown(item, request, text);
      return kept.trim().length === 0 ? null : kept;
    },
  };
}

export const CATALOG_AI_EVALUATION_SUITES: readonly EvaluationSuite[] = [
  writerSuite(DESCRIPTION_WRITER_SELLER),
  writerSuite(DESCRIPTION_WRITER_ADMIN),
];
