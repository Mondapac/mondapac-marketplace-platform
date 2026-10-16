import { Global, Module } from '@nestjs/common';
import { SMS_TRANSPORT, UnconfiguredSmsTransport } from './sms-transport';

/** Global: exports the port's token only. No provider is chosen yet (Phase 6 package 4). */
@Global()
@Module({
  providers: [{ provide: SMS_TRANSPORT, useClass: UnconfiguredSmsTransport }],
  exports: [SMS_TRANSPORT],
})
export class SmsModule {}
