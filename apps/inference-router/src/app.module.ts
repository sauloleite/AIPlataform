import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, RequestContextMiddleware } from '@aia/nest';
import { CompletionsModule } from './modules/completions/completions.module.js';
import { InfrastructureModule } from './shared/infrastructure.module.js';

@Module({
  imports: [InfrastructureModule, CompletionsModule],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
