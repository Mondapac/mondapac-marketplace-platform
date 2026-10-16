import { ApiProperty } from '@nestjs/swagger';

/** The holder's new display name, as typed (the server trims and checks it). */
export class ChangeDisplayNameRequest {
  @ApiProperty({
    description:
      'The new display name: 1 to 100 characters after trimming, no control characters, no ' +
      'URL-like text. Personal data: never logged or put in an event.',
  })
  displayName!: string;
}

export class DisplayNameChanged {
  @ApiProperty({ enum: ['display-name-changed'] })
  code!: 'display-name-changed';

  @ApiProperty({ description: 'False when the name already was the one given.' })
  changed!: boolean;
}

/** The holder's display preferences; null means "no choice". */
export class ChangePanelPreferencesRequest {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'An IANA time zone id (for example Australia/Brisbane), or null for the default.',
  })
  timezone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A panel language code from the supported list (en), or null for the default.',
  })
  locale!: string | null;
}

export class PanelPreferencesChanged {
  @ApiProperty({ enum: ['panel-preferences-changed'] })
  code!: 'panel-preferences-changed';

  @ApiProperty({ description: 'False when the values already were the ones given.' })
  changed!: boolean;
}
