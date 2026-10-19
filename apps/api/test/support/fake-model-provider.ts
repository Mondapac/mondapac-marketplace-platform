import type {
  ModelCredentials,
  ModelProvider,
  ModelRequest,
  ModelTurn,
} from '../../src/platform/ai/model-provider';

/**
 * The model provider every test application gets by default: it records each call and answers
 * from a script, or fails when the script is empty. No test reaches a real provider (ADR-0019
 * decision 9: `pnpm verify` stays offline).
 */
export class FakeModelProvider implements ModelProvider {
  readonly calls: { credentials: ModelCredentials; request: ModelRequest }[] = [];
  readonly script: (ModelTurn | Error)[] = [];

  call(credentials: ModelCredentials, request: ModelRequest): Promise<ModelTurn> {
    this.calls.push({ credentials, request: structuredClone(request) });
    const next = this.script.shift();
    if (next === undefined) return Promise.reject(new Error('no scripted model turn'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

/** A final text turn. */
export function textTurn(text: string, usage = { inputTokens: 1000, outputTokens: 100 }): ModelTurn {
  return { blocks: [{ type: 'text', text }], stop: 'end', usage };
}

/** A turn that asks for one tool. */
export function toolTurn(name: string, input: unknown, id = 'call-1'): ModelTurn {
  return {
    blocks: [{ type: 'tool-call', id, name, input }],
    stop: 'tool-use',
    usage: { inputTokens: 1000, outputTokens: 50 },
  };
}
