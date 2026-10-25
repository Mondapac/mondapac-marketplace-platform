import { ApiProperty } from '@nestjs/swagger';
import type { PublishedSlides } from '../application/use-cases/view-published-slides.use-case';

// The body of the public slider read. Every text is plain text for the buyer app to render as
// text; the image is a key of the buyer app's ready-made set (until the media upload exists) and
// the link a site path, never a URL.

export class PublishedSlideImageBody {
  @ApiProperty({ description: 'A key of the ready-made image set; never a URL.' }) key!: string;
  @ApiProperty({ description: 'Empty only when the image is decorative.' }) alt!: string;
  @ApiProperty() decorative!: boolean;
}

export class PublishedSlideBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['announcement', 'promotion', 'link'] }) kind!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({ nullable: true, type: String }) ctaLabel!: string | null;
  @ApiProperty({ nullable: true, type: PublishedSlideImageBody })
  image!: PublishedSlideImageBody | null;
  @ApiProperty({ enum: ['start', 'center', 'end'] }) textPosition!: string;
  @ApiProperty({ enum: ['light', 'dark'] }) textTone!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The one internal link of the whole slide, as a site path; null: no link.',
  })
  href!: string | null;
  @ApiProperty({ description: 'A paid placement: the buyer app labels it.' }) sponsored!: boolean;
}

export class PublishedSlidesBody {
  @ApiProperty() position!: string;
  @ApiProperty({ description: 'Autoplay allowed here and asked for by every slide shown.' })
  autoplay!: boolean;
  @ApiProperty({ type: [PublishedSlideBody] }) slides!: PublishedSlideBody[];
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'The nearest start or end ahead among the slides that could show on this page.',
  })
  nextChangeAt!: string | null;
}

export const publishedSlidesBody = (answer: PublishedSlides): PublishedSlidesBody => ({
  position: answer.position,
  autoplay: answer.autoplay,
  slides: answer.slides.map((slide) => ({ ...slide })),
  nextChangeAt: answer.nextChangeAt === null ? null : answer.nextChangeAt.toString(),
});
