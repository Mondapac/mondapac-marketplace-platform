import { ApiProperty } from '@nestjs/swagger';

// Bodies of the support contact routes.

export class SupportContactBody {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The support email address in force; null when none was ever set.',
  })
  email!: string | null;
  @ApiProperty({
    description: '0 while the Market default is in force, then 1, 2, ... per change.',
  })
  version!: number;
}

export class SetSupportContactRequest {
  @ApiProperty({ example: 'support@example.com', maxLength: 254 })
  email!: string;
  @ApiProperty({ description: 'The version the caller last read (0 for the Market default).' })
  expectedVersion!: number;
}
