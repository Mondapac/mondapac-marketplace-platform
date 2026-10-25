import { ApiProperty } from '@nestjs/swagger';
import type { SlideSummaryView } from '../application/use-cases/list-slides.use-case';
import type { SlideCopyPackage } from '../application/use-cases/prepare-slide-copy.use-case';
import type {
  SlideDetailView,
  SlideVersionView,
} from '../application/use-cases/view-slide.use-case';

// Bodies of the slide routes. Slide content is data (plain texts, ids, ready-made image keys);
// the buyer app renders every text as text. There is no URL in a slide, only typed internal links.

export class SlideSummaryBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['announcement', 'promotion', 'link'] }) kind!: string;
  @ApiProperty() internalName!: string;
  @ApiProperty({
    enum: ['draft', 'pending', 'scheduled', 'live', 'ended', 'paused', 'archived'],
    description: 'scheduled, live and ended follow from the window and the clock.',
  })
  status!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty() pinned!: boolean;
  @ApiProperty() sponsored!: boolean;
  @ApiProperty() hasDraft!: boolean;
  @ApiProperty({ type: [String] }) positions!: string[];
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class SlideListBody {
  @ApiProperty({ type: [SlideSummaryBody] }) slides!: SlideSummaryBody[];
}

export class SlideVersionBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() versionNo!: number;
  @ApiProperty() internalName!: string;
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      '{ title, body, ctaLabel, image: { ref, alt, decorative } | null, textPosition, textTone, link: { type, id } | null }',
  })
  content!: object | null;
  @ApiProperty({
    type: [Object],
    description: '{ position, scope, scopeId, includeSubcategories, sortOrder, autoplay }',
  })
  placements!: object[];
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty() pinned!: boolean;
  @ApiProperty() sponsored!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) approvedAt!: string | null;
}

export class SlideDetailBody extends SlideSummaryBody {
  @ApiProperty({ type: SlideVersionBody, nullable: true }) draft!: SlideVersionBody | null;
  @ApiProperty({ type: SlideVersionBody, nullable: true }) live!: SlideVersionBody | null;
  @ApiProperty({ description: 'The draft was sent for approval.' }) pending!: boolean;
  @ApiProperty({
    type: [Object],
    description: 'Newest first: { id, versionNo, createdAt, approvedAt }',
  })
  versions!: object[];
}

export class SlideRequest {
  @ApiProperty({
    enum: ['announcement', 'promotion', 'link'],
    required: false,
    description: 'On create only.',
  })
  kind?: string;
  @ApiProperty() internalName!: string;
  @ApiProperty({ type: Object }) content!: object;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time', description: 'Required; at most 90 days after startsAt.' })
  endsAt!: string;
  @ApiProperty({ required: false }) pinned?: boolean;
  @ApiProperty({ required: false }) sponsored?: boolean;
  @ApiProperty({ type: [Object], description: '1 to 10 placements at the closed position list.' })
  placements!: object[];
}

export class SlideCopyBody extends SlideRequest {}

export class SlideVersionRequest {
  @ApiProperty({ format: 'uuid' }) versionId!: string;
}

export class SlideApproveRequest {
  @ApiProperty({ description: 'The version number of the draft the admin reviewed.' })
  versionNo!: number;
}

export class SlideOrderRequest {
  @ApiProperty({ description: 'A position key, for example home.hero.' }) position!: string;
  @ApiProperty({ enum: ['all', 'category', 'product', 'seller', 'page'], required: false })
  scope?: string;
  @ApiProperty({ format: 'uuid', required: false, description: 'With every scope but all.' })
  scopeId?: string;
  @ApiProperty({
    type: [String],
    description:
      'Every live slide of the position and scope, each once, first shown first. A partial list, ' +
      'a duplicate or a slide that is not live there is refused.',
  })
  slideIds!: string[];
}

export class SlideOrderBody {
  @ApiProperty() position!: string;
  @ApiProperty() scope!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) scopeId!: string | null;
  @ApiProperty({ type: [String], description: 'The saved order, first shown first.' })
  slideIds!: string[];
}

const iso = (value: { toString(): string } | null): string | null =>
  value === null ? null : value.toString();

export function versionBody(version: SlideVersionView): SlideVersionBody {
  return {
    id: version.id,
    versionNo: version.versionNo,
    internalName: version.internalName,
    content: version.content,
    placements: [...version.placements],
    startsAt: version.startsAt.toString(),
    endsAt: version.endsAt.toString(),
    pinned: version.pinned,
    sponsored: version.sponsored,
    createdAt: version.createdAt.toString(),
    approvedAt: iso(version.approvedAt),
  };
}

export function slideSummaryBody(view: SlideSummaryView): SlideSummaryBody {
  return {
    id: view.id,
    kind: view.kind,
    internalName: view.internalName,
    status: view.status,
    startsAt: view.startsAt.toString(),
    endsAt: view.endsAt.toString(),
    pinned: view.pinned,
    sponsored: view.sponsored,
    hasDraft: view.hasDraft,
    positions: [...view.positions],
    updatedAt: view.updatedAt.toString(),
  };
}

export function slideDetailBody(view: SlideDetailView): SlideDetailBody {
  return {
    ...slideSummaryBody(view),
    draft: view.draft === null ? null : versionBody(view.draft),
    live: view.live === null ? null : versionBody(view.live),
    pending: view.pending,
    versions: view.versions.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      createdAt: v.createdAt.toString(),
      approvedAt: iso(v.approvedAt),
    })),
  };
}

export const slideCopyBody = (view: SlideCopyPackage): SlideCopyBody => ({
  kind: view.kind,
  internalName: view.internalName,
  content: view.content ?? {},
  startsAt: view.startsAt,
  endsAt: view.endsAt,
  pinned: view.pinned,
  sponsored: view.sponsored,
  placements: [...view.placements],
});
