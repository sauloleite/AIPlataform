import { InvalidBindingError } from '../errors/index.js';

/** The platform default when a binding names no rate of its own. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export interface ToolBindingProps {
  projectId: string;
  toolId: string;
  enabled: boolean;
  rateLimitPerMinute?: number;
  requireApproval?: boolean;
  updatedAt: Date;
}

/**
 * Whether a project may use a tool, and under what limits.
 *
 * The binding is this service's own state: the DEFINITION lives in the
 * registry. Separating them is what lets a tool be published once and allowed
 * per project, with different limits in each.
 */
export class ToolBinding {
  private constructor(private readonly props: ToolBindingProps) {}

  static create(input: {
    projectId: string;
    toolId: string;
    enabled?: boolean;
    rateLimitPerMinute?: number;
    requireApproval?: boolean;
    now: Date;
  }): ToolBinding {
    if (input.projectId.trim() === '') {
      throw new InvalidBindingError('A binding needs a project');
    }
    if (input.toolId.trim() === '') {
      throw new InvalidBindingError('A binding needs a tool');
    }
    if (input.rateLimitPerMinute !== undefined) {
      if (!Number.isInteger(input.rateLimitPerMinute) || input.rateLimitPerMinute < 1) {
        throw new InvalidBindingError('The rate limit must be a positive whole number per minute');
      }
    }

    return new ToolBinding({
      projectId: input.projectId,
      toolId: input.toolId,
      enabled: input.enabled ?? true,
      ...(input.rateLimitPerMinute !== undefined && {
        rateLimitPerMinute: input.rateLimitPerMinute,
      }),
      ...(input.requireApproval !== undefined && { requireApproval: input.requireApproval }),
      updatedAt: input.now,
    });
  }

  static rehydrate(props: ToolBindingProps): ToolBinding {
    return new ToolBinding({ ...props });
  }

  get projectId(): string {
    return this.props.projectId;
  }
  get toolId(): string {
    return this.props.toolId;
  }
  get enabled(): boolean {
    return this.props.enabled;
  }
  get requireApproval(): boolean | undefined {
    return this.props.requireApproval;
  }

  /** The binding's own rate, or the platform default. */
  get effectiveRateLimit(): number {
    return this.props.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  }

  snapshot(): Readonly<ToolBindingProps> {
    return { ...this.props };
  }
}
