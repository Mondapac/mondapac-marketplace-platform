import type { SubjectRateLimits } from '../../../platform/rate-limit/subject-rate-limits';
import type { MessageLimits } from '../application/ports/message-limits';

/** {@link MessageLimits} on the platform's shared counters, class `assistant-message`. */
export class SubjectMessageLimits implements MessageLimits {
  constructor(private readonly counters: SubjectRateLimits) {}

  count(subject: string) {
    return this.counters.count('assistant-message', subject);
  }
}
