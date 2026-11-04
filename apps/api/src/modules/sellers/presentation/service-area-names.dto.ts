import { ApiProperty } from '@nestjs/swagger';

export class ServiceAreaLanguageNameView {
  @ApiProperty({ description: 'The name that shows: the edited one, else the configured one.' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name the configuration holds; null when it has none for this language.',
  })
  configuredName!: string | null;

  @ApiProperty({ description: 'True when an admin edited this name.' })
  edited!: boolean;
}

export class ServiceAreaNamesRowView {
  @ApiProperty({ description: 'The configured code of the area (never changes).' })
  code!: string;

  @ApiProperty({ type: String, nullable: true })
  region!: string | null;

  @ApiProperty()
  sellerOnboardingEnabled!: boolean;

  @ApiProperty()
  deliveryEnabled!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/ServiceAreaLanguageNameView' },
    description: 'Language tag to name; only languages that have a name.',
  })
  names!: Record<string, ServiceAreaLanguageNameView>;
}

export class ServiceAreaNamesBody {
  @ApiProperty({ description: 'The required language; its name is the fallback.' })
  defaultLanguage!: string;

  @ApiProperty({ type: [String], description: 'Language tags a name may be written in.' })
  languages!: string[];

  @ApiProperty({ type: [ServiceAreaNamesRowView] })
  areas!: ServiceAreaNamesRowView[];
}

export class ServiceAreaNamesEditRequest {
  @ApiProperty({ description: 'A code the Market configuration lists.' })
  areaCode!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true, minLength: 1, maxLength: 120 },
    description:
      'Language tag (one listed in `languages`) to the new name, or null to restore the ' +
      'configured name of that language.',
  })
  names!: Record<string, string | null>;
}

export class ServiceAreaNamesEditBody {
  @ApiProperty({ type: ServiceAreaNamesRowView })
  area!: ServiceAreaNamesRowView;

  @ApiProperty({ description: 'How many languages changed; 0 when the request changed nothing.' })
  changed!: number;
}
