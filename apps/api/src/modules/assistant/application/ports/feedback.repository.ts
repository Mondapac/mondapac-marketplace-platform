import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Feedback } from '../../domain/feedback';

/** `assistant.feedback`: one thumbs per assistant message, the last write wins. */
export interface FeedbackRepository {
  /**
   * Records the thumbs on the assistant message at `position` of the conversation. False when
   * that position is not an assistant message of the conversation (a buyer message, or none).
   */
  save(
    market: MarketContext,
    conversationId: string,
    position: number,
    feedback: Feedback,
    at: Temporal.Instant,
  ): Promise<boolean>;
}

export const FEEDBACK_REPOSITORY = Symbol('FEEDBACK_REPOSITORY');
