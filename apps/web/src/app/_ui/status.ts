import type { AgentCard } from '../../modules/registry/application/use-cases/list-agents';

/** One mapping from asset status to badge colour, shared by list and detail. */
export const STATUS_TONE: Record<AgentCard['statusLabel'], 'success' | 'warning' | 'informative'> =
  {
    published: 'success',
    'unpublished changes': 'warning',
    'draft only': 'informative',
  };
