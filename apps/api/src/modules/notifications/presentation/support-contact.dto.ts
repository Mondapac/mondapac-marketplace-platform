import { ApiProperty } from '@nestjs/swagger';
import { LastChangedDto } from '../../../platform/audit/change-trail.dto';

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
  @ApiProperty({
    type: LastChangedDto,
    nullable: true,
    description:
      'Who changed the address last and when; null while the Market default is in force.',
  })
  lastChanged!: LastChangedDto | null;
}

export class PublicSupportContactBody {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The support email address in force; null when none is set.',
  })
  email!: string | null;
}

export class SetSupportContactRequest {
  @ApiProperty({ example: 'support@example.com', maxLength: 254 })
  email!: string;
  @ApiProperty({ description: 'The version the caller last read (0 for the Market default).' })
  expectedVersion!: number;
}
