import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../persistence/prisma.service';

export class HealthResponse {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';
}

@ApiTags('platform')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  /** Liveness: the process is up and serving HTTP. It checks no dependencies. */
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ type: HealthResponse })
  check(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: the process can reach the database and may receive traffic. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (checks the database)' })
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  async ready(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      // The cause goes to the log only; the response must not leak connection details.
      this.logger.error({ err: error }, 'readiness check failed: database unreachable');
      throw new ServiceUnavailableException('database unavailable');
    }
    return { status: 'ok' };
  }
}
