import { ApiProperty } from '@nestjs/swagger';
import type { Temporal } from '@mondapac/shared-kernel';
import { ALERT_RESOLUTIONS, ALERT_STATES } from '../domain/alert';
import { DELIVERY_CHANNELS, DELIVERY_OUTCOMES } from '../domain/delivery';
import { ALERT_KEY_TYPES } from '../domain/rules';
import { SEVERITIES } from '../domain/severity';
import type {
  AlertPage,
  AlertSummaryView,
} from '../application/use-cases/list-security-alerts.use-case';
import type { AlertDetailView } from '../application/use-cases/view-security-alert.use-case';
import type { OnCallView } from '../application/use-cases/view-on-call.use-case';
import type { SummaryView } from '../application/use-cases/view-security-summary.use-case';

const iso = (instant: Temporal.Instant | null): string | null =>
  instant === null ? null : instant.toString();

export class AlertSummaryBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() rule!: string;
  @ApiProperty({ description: 'English, one line.' }) title!: string;
  @ApiProperty({ enum: SEVERITIES }) severity!: string;
  @ApiProperty({ enum: ALERT_STATES }) state!: string;
  @ApiProperty({ enum: ALERT_KEY_TYPES }) keyType!: string;
  @ApiProperty({ description: 'The key; an address is masked in the list.' }) keyLabel!: string;
  @ApiProperty() eventCount!: number;
  @ApiProperty({ format: 'date-time' }) firstEventAt!: string;
  @ApiProperty({ format: 'date-time' }) lastEventAt!: string;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) acknowledgedAt!:
    string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) resolvedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) nextNotifyAt!: string | null;
  @ApiProperty({ description: 'Send it back to acknowledge or resolve.' }) version!: number;
}

export class AlertPageBody {
  @ApiProperty({ type: [AlertSummaryBody] }) alerts!: AlertSummaryBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The cursor of the next page.' })
  next!: string | null;
}

export class AlertDeliveryBody {
  @ApiProperty() step!: number;
  @ApiProperty({ description: 'The roster member code.' }) recipient!: string;
  @ApiProperty({ enum: DELIVERY_CHANNELS }) channel!: string;
  @ApiProperty({ enum: DELIVERY_OUTCOMES }) outcome!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

export class AlertDetailBody extends AlertSummaryBody {
  @ApiProperty({ description: 'The key in full.' }) keyValue!: string;
  @ApiProperty() notifyStep!: number;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) acknowledgedBy!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) resolvedBy!: string | null;
  @ApiProperty({ enum: ALERT_RESOLUTIONS, nullable: true, type: String }) resolution!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) resolutionNote!: string | null;
  @ApiProperty({ type: [AlertDeliveryBody] }) deliveries!: AlertDeliveryBody[];
}

export class AcknowledgeAlertRequest {
  @ApiProperty({ description: 'The version the responder saw; a stale act is refused (409).' })
  expectedVersion!: number;
}

export class ResolveAlertRequest {
  @ApiProperty({ description: 'The version the responder saw; a stale act is refused (409).' })
  expectedVersion!: number;
  @ApiProperty({ enum: ALERT_RESOLUTIONS }) resolution!: string;
  @ApiProperty({ minLength: 10, maxLength: 1000 }) note!: string;
}

class PersonBody {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

class LiveCountsBody {
  @ApiProperty() s1!: number;
  @ApiProperty() s2!: number;
  @ApiProperty() s3!: number;
  @ApiProperty() s4!: number;
}

export class SummaryBody {
  @ApiProperty({ type: LiveCountsBody, description: 'Open or acknowledged alerts by severity.' })
  live!: LiveCountsBody;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) rulesLastRanAt!:
    string | null;
  @ApiProperty({ type: PersonBody, nullable: true }) onCall!: PersonBody | null;
}

class RotationWeekBody extends PersonBody {
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
}

export class OnCallBody {
  @ApiProperty() configured!: boolean;
  @ApiProperty({ nullable: true, type: String }) zone!: string | null;
  @ApiProperty({ nullable: true, type: Object }) businessHours!: object | null;
  @ApiProperty({ nullable: true, type: Boolean }) inBusinessHours!: boolean | null;
  @ApiProperty({ type: PersonBody, nullable: true }) onCall!: PersonBody | null;
  @ApiProperty({ type: [PersonBody] }) escalation!: PersonBody[];
  @ApiProperty() escalationIntervalMinutes!: number;
  @ApiProperty() escalationMaxSteps!: number;
  @ApiProperty({ type: [RotationWeekBody] }) rotation!: RotationWeekBody[];
  @ApiProperty({ type: PersonBody, nullable: true }) incidentCommander!: PersonBody | null;
  @ApiProperty({ type: PersonBody, nullable: true }) securityOwner!: PersonBody | null;
  @ApiProperty({ type: Object, description: 'Channels by severity.' }) channels!: object;
}

export function alertSummaryBody(view: AlertSummaryView): AlertSummaryBody {
  return {
    id: view.id,
    rule: view.rule,
    title: view.title,
    severity: view.severity,
    state: view.state,
    keyType: view.keyType,
    keyLabel: view.keyLabel,
    eventCount: view.eventCount,
    firstEventAt: view.firstEventAt.toString(),
    lastEventAt: view.lastEventAt.toString(),
    openedAt: view.openedAt.toString(),
    acknowledgedAt: iso(view.acknowledgedAt),
    resolvedAt: iso(view.resolvedAt),
    nextNotifyAt: iso(view.nextNotifyAt),
    version: view.version,
  };
}

export function alertPageBody(page: AlertPage): AlertPageBody {
  return { alerts: page.alerts.map(alertSummaryBody), next: page.next };
}

export function alertDetailBody(view: AlertDetailView): AlertDetailBody {
  return {
    ...alertSummaryBody(view),
    keyValue: view.keyValue,
    notifyStep: view.notifyStep,
    acknowledgedBy: view.acknowledgedBy,
    resolvedBy: view.resolvedBy,
    resolution: view.resolution,
    resolutionNote: view.resolutionNote,
    deliveries: view.deliveries.map((row) => ({
      step: row.step,
      recipient: row.recipient,
      channel: row.channel,
      outcome: row.outcome,
      at: row.at.toString(),
    })),
  };
}

export function summaryBody(view: SummaryView): SummaryBody {
  return { live: { ...view.live }, rulesLastRanAt: iso(view.rulesLastRanAt), onCall: view.onCall };
}

export function onCallBody(view: OnCallView): OnCallBody {
  return {
    ...view,
    escalation: [...view.escalation],
    rotation: view.rotation.map((week) => ({
      code: week.code,
      name: week.name,
      startsAt: week.startsAt.toString(),
    })),
    channels: view.channels,
    businessHours: view.businessHours,
  };
}
