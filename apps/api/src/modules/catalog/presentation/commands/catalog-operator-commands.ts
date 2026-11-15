import type { OperatorCommand } from '../../../../platform/operator/operator-command';
import { ReprocessImageFormats } from '../../application/use-cases/reprocess-image-formats.use-case';

/**
 * Catalog's operator routine, run by the platform's operator runner as the Market's `SYSTEM`
 * actor after the operator line is written (platform-audit 9.2). It reaches one use case with the
 * `system` rule. The body holds counts only.
 */
export const CATALOG_OPERATOR_COMMANDS: readonly OperatorCommand[] = Object.freeze([
  {
    name: 'reprocess-image-formats',
    flags: [],
    async run(app, context) {
      const result = await app.get(ReprocessImageFormats).execute(context, {});
      return result.ok
        ? {
            // Done only when nothing was left: a photo that failed is for a second run.
            done: result.value.failed === 0,
            body: {
              outcome: result.value.failed === 0 ? 'complete' : 'incomplete',
              scanned: result.value.scanned,
              completed: result.value.completed,
              failed: result.value.failed,
            },
          }
        : { done: false, body: { outcome: result.error.code } };
    },
  },
]);

export const CATALOG_OPERATOR_USAGE = 'usage: operator reprocess-image-formats --market <id>';
