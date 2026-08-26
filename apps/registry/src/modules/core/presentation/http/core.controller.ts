import { Controller, Get, Req } from '@nestjs/common';
import { POLICY, authorize } from '@aia/auth';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';
import { Example } from '../../application/use-cases/example.js';

/** Adapts HTTP to the use cases. No business rule here. */
@Controller('v1/registry')
export class RegistryController {
  constructor(private readonly example: Example) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ id: string }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return this.example.execute({ projectId });
  }
}
