import { ApiProperty } from '@nestjs/swagger';
import { lastChangedBody, type LastChanged } from '../../../platform/audit/change-trail';
import { LastChangedDto } from '../../../platform/audit/change-trail.dto';
import type { SeoSettingsPage } from '../application/use-cases/view-seo-settings.use-case';
import type { PublicSeo, SeoSettings } from '../domain/seo-settings';

// The bodies of the SEO settings routes. The settings object is documented as an object whose
// fields are listed in docs/modules/storefront/seo-settings.md; every field is required on write.

export class SeoSettingsBody {
  @ApiProperty({ description: '0 while the code defaults are in force.' })
  version!: number;
  @ApiProperty({
    type: Object,
    description:
      'indexing, siteName, titleTemplate, defaultDescription, defaultShareImage, logo, sellerPages, ' +
      'tradingName, legalName, abn, postalAddress, contactEmail, contactPhone, sameAs, ' +
      'googleVerification, bingVerification, analyticsId, pageTemplates.',
  })
  settings!: SeoSettings;
  @ApiProperty({
    description: 'True while the storefront runs on sample data: indexing cannot be turned on.',
  })
  sampleDataLock!: boolean;
  @ApiProperty({
    enum: ['on', 'off'],
    description: 'off keeps every page out of the index whatever the switch says.',
  })
  envCeiling!: 'on' | 'off';
  @ApiProperty({ type: LastChangedDto, nullable: true })
  lastChanged!: LastChangedDto | null;
}

export class SetSeoSettingsRequest {
  @ApiProperty({ description: 'The version the screen read.' })
  expectedVersion!: number;
  @ApiProperty({
    type: Object,
    description:
      'Exactly the fields of this route, all required: siteName, titleTemplate, defaultDescription, ' +
      'defaultShareImage, sellerPages, sameAs, pageTemplates (edit); or indexing, logo, tradingName, ' +
      'legalName, abn, postalAddress, contactEmail, contactPhone, googleVerification, ' +
      'bingVerification, analyticsId (protected).',
  })
  settings!: Record<string, unknown>;
}

export class RestoreSeoSettingsRequest {
  @ApiProperty({ description: 'The version the screen read.' })
  expectedVersion!: number;
  @ApiProperty({ description: 'The version to bring back (0 is the code defaults).' })
  version!: number;
}

export class PublicSeoBody {
  @ApiProperty({
    type: Object,
    description: 'The public fields only: no version, no editor, no focus keywords.',
  })
  seo!: PublicSeo;
}

export function seoSettingsBody(page: SeoSettingsPage & { lastChanged: LastChanged | null }) {
  return {
    version: page.version,
    settings: page.settings,
    sampleDataLock: page.sampleDataLock,
    envCeiling: page.envCeiling,
    lastChanged: lastChangedBody(page.lastChanged),
  };
}
