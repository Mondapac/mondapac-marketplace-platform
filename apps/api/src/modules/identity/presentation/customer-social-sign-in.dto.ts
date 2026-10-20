import { ApiProperty } from '@nestjs/swagger';

/** The sign-in providers a Market offers its customers (social sign-in). */
export class SignInProvidersAnswer {
  @ApiProperty({
    enum: ['google'],
    isArray: true,
    description: 'Configured providers; empty hides every provider button.',
  })
  providers!: string[];
}
