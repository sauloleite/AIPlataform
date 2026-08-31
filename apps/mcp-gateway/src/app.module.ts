import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, RequestContextMiddleware } from '@aia/nest';
import { ToolsModule } from './modules/tools/tools.module.js';
import { InfrastructureModule } from './shared/infrastructure.module.js';

@Module({
  imports: [InfrastructureModule, ToolsModule],
  // Global guard: a route has to declare itself public to escape it.
  // Forgetting the decorator fails closed.
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
