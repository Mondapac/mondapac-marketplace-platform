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
