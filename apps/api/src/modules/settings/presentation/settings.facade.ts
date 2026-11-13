import type { CallContext } from '@mondapac/shared-kernel';
import type { ReadAiDescriptionWriter } from '../application/use-cases/read-ai-description-writer.use-case';
import type { SettingsFacade } from '../contracts/settings.facade';

/** {@link SettingsFacade} on the settings use cases; a refusal or a throw is off. */
export class SettingsFacadeImplementation implements SettingsFacade {
  constructor(private readonly readAiDescriptionWriter: ReadAiDescriptionWriter) {}

  async aiDescriptionWriter(context: CallContext) {
    try {
      const answer = await this.readAiDescriptionWriter.execute(context, {});
      if (answer.ok) return answer.value;
    } catch {
      // Fail closed below.
    }
    return { enabled: false, tier: 'fast' as const };
  }
}
