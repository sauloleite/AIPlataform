import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, RequestContextMiddleware } from '@aia/nest';
import { RegistryModule } from './modules/core/core.module.js';
import { InfrastructureModule } from './shared/infrastructure.module.js';

@Module({
  imports: [InfrastructureModule, RegistryModule],
  // Guard global: a rota precisa se declarar publica para escapar dele.
  // Esquecer o decorator falha fechado.
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
