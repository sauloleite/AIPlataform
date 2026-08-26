import { Controller, Get, Req } from '@nestjs/common';
import { POLICY, authorize } from '@aia/auth';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';
import { Exemplo } from '../../application/use-cases/exemplo.js';

/** Adapta HTTP para os casos de uso. Nenhuma regra de negocio aqui. */
@Controller('v1/registry')
export class RegistryController {
  constructor(private readonly exemplo: Exemplo) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ id: string }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return this.exemplo.execute({ projectId });
  }
}
