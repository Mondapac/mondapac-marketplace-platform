import { ApiProperty } from '@nestjs/swagger';

/** One action's two-step rule in the shop. */
export class StepUpPolicyItemView {
  @ApiProperty({ description: 'The action, `<module>.<noun>.<verb>`.' })
  actionKey!: string;

  @ApiProperty({
    description: 'What applies now: the platform floor, the shop rule or the default.',
  })
  required!: boolean;

  @ApiProperty({ description: 'The platform floor: always required, cannot be turned off.' })
  locked!: boolean;

  @ApiProperty({ description: 'What applies when the shop has set no rule of its own.' })
  defaultRequired!: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'When the shop last set its own rule (ISO 8601 UTC), or null.',
  })
  updatedAt!: string | null;
}

export class StepUpPolicyView {
  @ApiProperty({
    type: [StepUpPolicyItemView],
    description: 'One row per registered action, by key.',
  })
  items!: StepUpPolicyItemView[];
}

export class StepUpPolicySetRequest {
  @ApiProperty({ description: 'A registered action key.' })
  actionKey!: string;

  @ApiProperty({ description: 'Whether the action asks for a fresh two-step code.' })
  required!: boolean;

  @ApiProperty({ description: 'A current code from the app, or a recovery code.' })
  code!: string;
}

export class StepUpPolicySet {
  @ApiProperty({ enum: ['step-up-policy.changed', 'step-up-policy.unchanged'] })
  code!: 'step-up-policy.changed' | 'step-up-policy.unchanged';

  @ApiProperty()
  actionKey!: string;

  @ApiProperty()
  required!: boolean;
}

export class StepUpVerifyRequest {
  @ApiProperty({ description: 'A registered action key.' })
  actionKey!: string;

  @ApiProperty({ description: 'A current code from the app, or a recovery code.' })
  code!: string;
}

export class StepUpVerified {
  @ApiProperty({ enum: ['step-up-verified'] })
  code!: 'step-up-verified';

  @ApiProperty()
  actionKey!: string;
}
