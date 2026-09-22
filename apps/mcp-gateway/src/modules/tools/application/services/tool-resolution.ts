/**
 * The lookups every tools use case shares: which definition an id names, which
 * executor runs it, and whether the project's classification is needed.
 */
import { BUILTIN_TOOL_PREFIX, findBuiltinTool } from '../../domain/value-objects/builtin-tools.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { ClassificationReader, ToolCatalog, ToolExecutor } from '../ports.js';

export async function findTool(
  catalog: ToolCatalog,
  input: { projectId: string; accessToken: string; toolId: string },
): Promise<ToolDefinition | null> {
  // A built-in id is answered without the registry. The registry would only
  // say 404, and its outage must not take the platform's own tools with it.
  if (input.toolId.startsWith(BUILTIN_TOOL_PREFIX)) return findBuiltinTool(input.toolId);
  return catalog.find(input);
}

export type Readiness =
  | { readonly executor: ToolExecutor; readonly reason: null }
  | { readonly executor: null; readonly reason: string };

export async function readinessOf(
  executors: readonly ToolExecutor[],
  tool: ToolDefinition,
): Promise<Readiness> {
  const executor = executors.find((candidate) => candidate.supports(tool));
  if (executor === undefined) {
    const kind =
      tool.builtinId === undefined ? `a ${tool.toolType} tool` : `the ${tool.builtinId} built-in`;
    return { executor: null, reason: `No executor is configured for ${kind}` };
  }
  const reason = await executor.unavailableReason();
  return reason === null ? { executor, reason: null } : { executor: null, reason };
}

/**
 * The classification, or undefined when it could not be read.
 *
 * Undefined is not a pass: the domain refuses a tool that leaves the platform
 * without one (see `dataZoneRefusal`). What it buys is that governance being
 * down costs web search, not calculator, file search and every registry tool
 * besides. The adapter has already logged why.
 */
export async function classificationFor(
  reader: ClassificationReader,
  input: { projectId: string; accessToken: string },
  tools: readonly ToolDefinition[],
): Promise<string | undefined> {
  const leavesPlatform = tools.some(
    (tool) => tool.dataZone !== undefined && tool.dataZone !== 'local',
  );
  if (!leavesPlatform) return undefined;

  try {
    return await reader.classificationOf(input);
  } catch {
    return undefined;
  }
}
