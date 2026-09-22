/**
 * The tools the platform provides in every project, without anyone creating
 * them (ADR-024).
 *
 * Defined here rather than published in the registry because a built-in's
 * definition cannot be separated from the code that runs it: the argument
 * schema a model is shown IS what the executor parses. Publishing it as an
 * asset would give one thing two sources of truth, and a project could edit
 * the copy into something the executor does not accept.
 */
import type { ToolDefinition } from './index.js';

/**
 * Registry asset ids are generated, and none contains a dot, so no asset can
 * ever take one of these ids. The prefix is also what tells the registry an
 * agent is attaching a built-in rather than naming an asset that is missing.
 */
export const BUILTIN_TOOL_PREFIX = 'builtin.';

export const BUILTIN_IDS = [
  'web_search',
  'web_fetch',
  'current_time',
  'calculator',
  'file_search',
] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

export function builtinToolId(builtinId: BuiltinId): string {
  return `${BUILTIN_TOOL_PREFIX}${builtinId}`;
}

/**
 * The descriptions are written for the MODEL, which is the only reader that
 * decides whether to call a tool. They say when to use it, not how it works.
 */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  {
    toolId: builtinToolId('web_search'),
    slug: 'web-search',
    name: 'Web search',
    description:
      'Searches the public web and returns the most relevant pages, each with a title, a URL and ' +
      'a short snippet. Use it for recent events, or for facts that may have changed since you ' +
      'were trained. To read a result in full, pass its URL to web-fetch.',
    toolType: 'builtin',
    source: 'platform',
    builtinId: 'web_search',
    // Reads, and changes nothing anywhere. The query still leaves the
    // platform, which is what `dataZone` governs -- not the risk level.
    riskLevel: 'low',
    dataZone: 'global',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.', maxLength: 400 },
        max_results: {
          type: 'integer',
          description: 'How many results to return, 1 to 10. Defaults to 5.',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    toolId: builtinToolId('web_fetch'),
    slug: 'web-fetch',
    name: 'Web page reader',
    description:
      'Reads a public web page and returns its title and text. Use it to read a page in full, ' +
      'for example a result from web-search. Only public http and https addresses can be read, ' +
      'and a long page is cut short.',
    toolType: 'builtin',
    source: 'platform',
    builtinId: 'web_fetch',
    // Medium, though it only reads: the URL itself is a channel out. A model
    // steered by an injected instruction can put what it knows into the query
    // string of a page it is told to read (OWASP LLM01).
    riskLevel: 'medium',
    dataZone: 'global',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http or https address to read.', maxLength: 2048 },
      },
      required: ['url'],
    },
  },
  {
    toolId: builtinToolId('current_time'),
    slug: 'current-time',
    name: 'Current time',
    description:
      "Returns the current date and time in UTC and, optionally, in a time zone such as 'America/Sao_Paulo'. " +
      'Use it whenever an answer depends on today’s date or the time of day.',
    toolType: 'builtin',
    source: 'platform',
    builtinId: 'current_time',
    riskLevel: 'low',
    dataZone: 'local',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'An IANA time zone name. Leave it out for UTC only.',
          maxLength: 64,
        },
      },
    },
  },
  {
    toolId: builtinToolId('calculator'),
    slug: 'calculator',
    name: 'Calculator',
    description:
      'Evaluates an arithmetic expression and returns the exact number. Use it instead of ' +
      'working arithmetic out yourself. Supports + - * / % ^, parentheses, the functions sqrt, ' +
      'abs, round, floor, ceil, min, max, log, ln, exp, sin, cos and tan, and the constants pi and e.',
    toolType: 'builtin',
    source: 'platform',
    builtinId: 'calculator',
    riskLevel: 'low',
    dataZone: 'local',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: "For example '(1250 * 0.15) + 3^2'.",
          maxLength: 500,
        },
      },
      required: ['expression'],
    },
  },
  {
    toolId: builtinToolId('file_search'),
    slug: 'file-search',
    name: 'File search',
    description:
      'Searches the documents in the knowledge stores attached to this agent and returns the ' +
      'passages most relevant to the query.',
    toolType: 'builtin',
    source: 'platform',
    builtinId: 'file_search',
    riskLevel: 'low',
    // aia-knowledge, as the caller. Nothing leaves the platform.
    dataZone: 'local',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up.' },
        store_id: { type: 'string', description: 'The store to search.' },
        top_k: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query', 'store_id'],
    },
  },
];

export function findBuiltinTool(toolId: string): ToolDefinition | null {
  if (!toolId.startsWith(BUILTIN_TOOL_PREFIX)) return null;
  return BUILTIN_TOOLS.find((tool) => tool.toolId === toolId) ?? null;
}
