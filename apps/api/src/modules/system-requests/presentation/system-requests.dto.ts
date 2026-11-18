import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { POLICY_AREAS, REVIEW_AREAS, RISKS } from '../domain/areas';
import {
  ACTIVITY_KINDS,
  DECISIONS,
  displayNumber,
  REQUEST_ACTIONS,
  REQUEST_MODES,
  REQUEST_STATUSES,
  REQUEST_VIEWS,
} from '../domain/request';
import type { MatchingOutcome } from '../application/use-cases/approve-matching-system-requests.use-case';
import type { BulkOutcome } from '../application/use-cases/approve-system-requests.use-case';
import type { BadgeView } from '../application/use-cases/count-system-requests.use-case';
import type { RequestListView } from '../application/use-cases/list-system-requests.use-case';
import type {
  AreaPolicyView,
  DueDaysView,
  PolicyChangeView,
  PolicyView,
} from '../application/use-cases/view-review-policy.use-case';
import type {
  ActivityView,
  RequestDetailView,
  RequestView,
} from '../application/use-cases/view-system-request.use-case';
import type { RecordedRequest } from '../contracts/recorder';

// The bodies of the System requests routes. Instants are ISO 8601 (UTC); people are account ids
// with their display names beside them (identity's facade; null when unknown). The values before
// and after are the owning module's JSON object, rendered by the panel per subject kind.

export class RequestBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The number admins see, without the SR- prefix.' }) number!: number;
  @ApiProperty({ example: 'SR-1042' }) displayNumber!: string;
  @ApiProperty({ enum: REVIEW_AREAS }) area!: string;
  @ApiProperty({ description: '`<module>.<subject>`, e.g. system-requests.policy-area.' })
  subjectKind!: string;
  @ApiProperty() subjectRef!: string;
  @ApiProperty({
    enum: REQUEST_MODES,
    description:
      'review: the change went live when made, and a reject restores the value before. ' +
      'approval: the action (a delete, a merge, an import) waits for approval and is applied by ' +
      'it; a reject or withdraw changes nothing (status reverted, nothing applied). `before` is ' +
      'what the subject held when asked, `after` describes the action.',
  })
  mode!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The owning module's label of the subject (a store name, a setting's name); null when " +
      'the module gives none or it cannot be read.',
  })
  subjectLabel!: string | null;
  @ApiProperty({ enum: RISKS }) risk!: string;
  @ApiProperty({ enum: REQUEST_STATUSES }) status!: string;
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'The values before the change (a JSON object); null unless the caller is the author or ' +
      "holds the area's review key.",
  })
  before!: Record<string, unknown> | null;
  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'The values after the change; null as for before.',
  })
  after!: Record<string, unknown> | null;
  @ApiProperty({ description: "The author's note." }) note!: string;
  @ApiProperty({ format: 'uuid' }) requestedBy!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The author's display name; null when it cannot be read.",
  })
  requestedByName!: string | null;
  @ApiProperty({ format: 'date-time', description: 'When the change went live.' })
  appliedAt!: string;
  @ApiProperty({ format: 'date-time' }) reviewDueAt!: string;
  @ApiProperty({ description: 'Open and past its review date.' }) overdue!: boolean;
  @ApiProperty({ enum: DECISIONS, nullable: true, type: String }) decision!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) decidedBy!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The decider's display name; null while open or when it cannot be read.",
  })
  decidedByName!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionReason!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'A later request on the same subject: this one can no longer be reverted.',
  })
  supersededBy!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The SR number of supersededBy (for the "Superseded by SR-n" link).',
  })
  supersededByNumber!: number | null;
  @ApiProperty() commentCount!: number;
  @ApiProperty({ description: 'The permission key a reviewer of this request holds.' })
  reviewPermission!: string;
  @ApiProperty({
    enum: REQUEST_ACTIONS,
    isArray: true,
    description: "The caller's actions on this row: the row menu shows exactly these.",
  })
  actions!: string[];
}

export class ActivityBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ACTIVITY_KINDS }) kind!: string;
  @ApiProperty({ format: 'uuid' }) actor!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The actor's display name; null when it cannot be read.",
  })
  actorName!: string | null;
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The comment or the reason.' })
  body!: string | null;
}

export class RequestDetailBody extends RequestBody {
  @ApiProperty({ type: [ActivityBody], description: 'Oldest first.' }) activity!: ActivityBody[];
}

export class RequestCountsBody {
  @ApiProperty() 'needs-my-review'!: number;
  @ApiProperty() 'all-open'!: number;
  @ApiProperty() mine!: number;
  @ApiProperty() approved!: number;
  @ApiProperty() reverted!: number;
  @ApiProperty() overdue!: number;
  @ApiProperty() all!: number;
}

export class RequestListBody {
  @ApiProperty({ type: [RequestBody] }) rows!: RequestBody[];
  @ApiProperty({
    type: RequestCountsBody,
    description: 'Every view for the same search and filters (each at most 10,000).',
  })
  counts!: RequestCountsBody;
  @ApiProperty({ type: Number, nullable: true, description: 'Page mode only; at most 10,000.' })
  total!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Page mode only: from 1.' })
  page!: number | null;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: String, nullable: true, description: 'Cursor mode only.' })
  nextCursor!: string | null;
}

export class BadgeBody {
  @ApiProperty({ description: 'Open requests the caller may review, not their own.' })
  needsMyReview!: number;
  @ApiProperty() overdue!: number;
}

export class CommentRequest {
  @ApiProperty({ description: '1 to 2000 characters.' }) body!: string;
}

export class ReasonRequest {
  @ApiProperty({ description: '1 to 500 characters.' }) reason!: string;
}

export class BulkApproveRequest {
  @ApiProperty({ type: [String], description: '1 to 100 distinct request ids (low risk only).' })
  requestIds!: string[];
}

export class BulkOutcomeBody {
  @ApiProperty({ format: 'uuid' }) requestId!: string;
  @ApiProperty({ description: '`approved`, or the refusal code for this request.' })
  outcome!: string;
}

export class BulkApproveBody {
  @ApiProperty({ type: [BulkOutcomeBody] }) results!: BulkOutcomeBody[];
}

/** The filter of "select all matching": the list's own query fields, as strings. */
export class BulkApproveMatchingRequest {
  @ApiPropertyOptional({ enum: REQUEST_VIEWS, description: 'Default all-open.' }) view?: string;
  @ApiPropertyOptional({ description: 'An SR number or a part of the note, kind or key.' })
  q?: string;
  @ApiPropertyOptional({ description: 'Comma list of areas.' }) area?: string;
  @ApiPropertyOptional({ description: 'Comma list of risks (only low is approved).' })
  risk?: string;
  @ApiPropertyOptional({ description: 'Comma list of statuses (only open is approved).' })
  status?: string;
  @ApiPropertyOptional({ format: 'uuid' }) requestedBy?: string;
  @ApiPropertyOptional({ format: 'uuid' }) decidedBy?: string;
  @ApiPropertyOptional({ format: 'date-time' }) appliedFrom?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Exclusive.' }) appliedTo?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'] }) overdue?: string;
  @ApiPropertyOptional() subjectKind?: string;
  @ApiPropertyOptional() subjectRef?: string;
}

export class MatchingApprovedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() number!: number;
  @ApiProperty({ example: 'SR-1042' }) displayNumber!: string;
}

export class MatchingFailedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The refusal code for this request, e.g. system-requests.decided.' })
  code!: string;
}

export class BulkApproveMatchingBody {
  @ApiProperty({ type: [MatchingApprovedBody], description: 'Oldest SR number first.' })
  approved!: MatchingApprovedBody[];
  @ApiProperty({ type: [MatchingFailedBody] }) failed!: MatchingFailedBody[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Approvable requests that still match (at most 10,000). Call again while above 0 and the ' +
      'last call approved at least one. null: the count could not be read after the approvals ' +
      'committed; the panel stops and reloads the list.',
  })
  remaining!: number | null;
}

export class RecordedRequestBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() number!: number;
  @ApiProperty({ example: 'SR-1042' }) displayNumber!: string;
  @ApiProperty({ enum: RISKS }) risk!: string;
  @ApiProperty({ format: 'date-time' }) reviewDueAt!: string;
}

export class AreaPolicyBody {
  @ApiProperty({ enum: POLICY_AREAS }) area!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: RISKS }) risk!: string;
  @ApiProperty() reviewPermission!: string;
  @ApiProperty({ description: '0 while the default is in force.' }) version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) updatedBy!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The display name of updatedBy; null when unknown or unreadable.',
  })
  updatedByName!: string | null;
}

export class DueDaysBody {
  @ApiProperty({ minimum: 1, maximum: 90 }) reviewDueDays!: number;
  @ApiProperty({ description: '0 while the default (7) is in force.' }) version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) updatedBy!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The display name of updatedBy; null when unknown or unreadable.',
  })
  updatedByName!: string | null;
}

export class ReviewPolicyRowBody {
  @ApiProperty({ enum: ['high'] }) risk!: string;
  @ApiProperty() reviewPermission!: string;
}

export class PolicyBody {
  @ApiProperty({ type: [AreaPolicyBody] }) areas!: AreaPolicyBody[];
  @ApiProperty({ type: DueDaysBody }) reviewDueDays!: DueDaysBody;
  @ApiProperty({
    type: ReviewPolicyRowBody,
    description: 'The review policy itself: always reviewed, as high risk.',
  })
  reviewPolicy!: ReviewPolicyRowBody;
}

export class AreaPolicyChangeBody {
  @ApiProperty({ type: AreaPolicyBody }) value!: AreaPolicyBody;
  @ApiPropertyOptional({
    type: RecordedRequestBody,
    nullable: true,
    description: 'The review request the change opened; null when nothing changed.',
  })
  request!: RecordedRequestBody | null;
}

export class DueDaysChangeBody {
  @ApiProperty({ type: DueDaysBody }) value!: DueDaysBody;
  @ApiPropertyOptional({ type: RecordedRequestBody, nullable: true })
  request!: RecordedRequestBody | null;
}

export class ChangeAreaPolicyRequest {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: RISKS }) risk!: string;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({ description: 'Why: 1 to 500 characters, shown to the reviewer.' }) note!: string;
}

export class ChangeDueDaysRequest {
  @ApiProperty({ minimum: 1, maximum: 90 }) reviewDueDays!: number;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({ description: 'Why: 1 to 500 characters, shown to the reviewer.' }) note!: string;
}

const iso = (value: { toString(): string } | null): string | null =>
  value === null ? null : value.toString();

export const requestBody = (view: RequestView): RequestBody => ({
  id: view.id,
  number: view.number,
  displayNumber: displayNumber(view.number),
  area: view.area,
  subjectKind: view.subjectKind,
  subjectRef: view.subjectRef,
  mode: view.mode,
  subjectLabel: view.subjectLabel,
  risk: view.risk,
  status: view.status,
  before: view.before,
  after: view.after,
  note: view.note,
  requestedBy: view.requestedBy,
  requestedByName: view.requestedByName,
  appliedAt: view.appliedAt.toString(),
  reviewDueAt: view.reviewDueAt.toString(),
  overdue: view.overdue,
  decision: view.decision,
  decidedBy: view.decidedBy,
  decidedByName: view.decidedByName,
  decidedAt: iso(view.decidedAt),
  decisionReason: view.decisionReason,
  supersededBy: view.supersededBy,
  supersededByNumber: view.supersededByNumber,
  commentCount: view.commentCount,
  reviewPermission: view.reviewPermission,
  actions: [...view.actions],
});

export const activityBody = (line: ActivityView): ActivityBody => ({
  id: line.id,
  kind: line.kind,
  actor: line.actor,
  actorName: line.actorName,
  at: line.at.toString(),
  body: line.body,
});

export const requestDetailBody = (view: RequestDetailView): RequestDetailBody => ({
  ...requestBody(view),
  activity: view.activity.map(activityBody),
});

export const requestListBody = (view: RequestListView): RequestListBody => ({
  rows: view.rows.map(requestBody),
  counts: Object.fromEntries(
    REQUEST_VIEWS.map((name) => [name, view.counts[name]]),
  ) as unknown as RequestCountsBody,
  total: view.total,
  page: view.page,
  pageSize: view.pageSize,
  nextCursor: view.nextCursor,
});

export const badgeBody = (view: BadgeView): BadgeBody => ({ ...view });

export const bulkApproveBody = (outcomes: readonly BulkOutcome[]): BulkApproveBody => ({
  results: outcomes.map((outcome) => ({ ...outcome })),
});

export const bulkApproveMatchingBody = (outcome: MatchingOutcome): BulkApproveMatchingBody => ({
  approved: outcome.approved.map((row) => ({
    id: row.id,
    number: row.number,
    displayNumber: displayNumber(row.number),
  })),
  failed: outcome.failed.map((row) => ({ id: row.id, code: row.code })),
  remaining: outcome.remaining,
});

const recordedBody = (request: RecordedRequest | null): RecordedRequestBody | null =>
  request === null
    ? null
    : {
        id: request.id,
        number: request.number,
        displayNumber: displayNumber(request.number),
        risk: request.risk,
        reviewDueAt: request.reviewDueAt.toString(),
      };

const areaPolicyBody = (view: AreaPolicyView): AreaPolicyBody => ({
  area: view.area,
  enabled: view.enabled,
  risk: view.risk,
  reviewPermission: view.reviewPermission,
  version: view.version,
  updatedAt: iso(view.updatedAt),
  updatedBy: view.updatedBy,
  updatedByName: view.updatedByName,
});

const dueDaysBody = (view: DueDaysView): DueDaysBody => ({
  reviewDueDays: view.reviewDueDays,
  version: view.version,
  updatedAt: iso(view.updatedAt),
  updatedBy: view.updatedBy,
  updatedByName: view.updatedByName,
});

export const policyBody = (view: PolicyView): PolicyBody => ({
  areas: view.areas.map(areaPolicyBody),
  reviewDueDays: dueDaysBody(view.reviewDueDays),
  reviewPolicy: { ...view.reviewPolicy },
});

export const areaPolicyChangeBody = (
  view: PolicyChangeView<AreaPolicyView>,
): AreaPolicyChangeBody => ({
  value: areaPolicyBody(view.value),
  request: recordedBody(view.request),
});

export const dueDaysChangeBody = (view: PolicyChangeView<DueDaysView>): DueDaysChangeBody => ({
  value: dueDaysBody(view.value),
  request: recordedBody(view.request),
});
