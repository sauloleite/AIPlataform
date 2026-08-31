/**
 * One validator per asset kind, looked up by kind.
 *
 * A map rather than a `switch` inside the use case: adding a kind means adding
 * an entry here, and nothing in `application/` changes. That is the difference
 * between this module growing and `PublishVersion` growing.
 */
import { InvalidDefinitionError } from '../errors/index.js';
import {
  BUILTIN_TOOLS,
  RISK_LEVELS,
  TOOL_TYPES,
  type AgentDefinition,
  type AssetDefinition,
  type AssetKind,
  type PromptDefinition,
  type ToolDefinition,
} from '../value-objects/index.js';

export interface DefinitionValidator {
  validate(definition: AssetDefinition): void;
}

const agentValidator: DefinitionValidator = {
  validate(definition) {
    const agent = definition as AgentDefinition;
    if (agent.instructions.trim().length === 0) {
      throw new InvalidDefinitionError('An agent needs instructions');
    }
    if (agent.modelAlias.trim().length === 0) {
      throw new InvalidDefinitionError('An agent needs a model alias');
    }
    if (agent.temperature !== undefined && (agent.temperature < 0 || agent.temperature > 2)) {
      throw new InvalidDefinitionError('temperature must be between 0 and 2');
    }
    if (agent.topP !== undefined && (agent.topP < 0 || agent.topP > 1)) {
      throw new InvalidDefinitionError('top_p must be between 0 and 1');
    }
    if (agent.maxOutputTokens !== undefined && agent.maxOutputTokens < 1) {
      throw new InvalidDefinitionError('max_output_tokens must be positive');
    }
    // The same store twice is not an error the model would notice, but it
    // doubles the retrieval cost of every run for no benefit.
    const stores = agent.knowledge.map((reference) => reference.storeId);
    if (new Set(stores).size !== stores.length) {
      throw new InvalidDefinitionError('The same vector store is attached more than once');
    }
    const tools = agent.tools.map((reference) => reference.assetId);
    if (new Set(tools).size !== tools.length) {
      throw new InvalidDefinitionError('The same tool is attached more than once');
    }
  },
};

const toolValidator: DefinitionValidator = {
  validate(definition) {
    const tool = definition as ToolDefinition;
    if (!TOOL_TYPES.includes(tool.toolType)) {
      throw new InvalidDefinitionError(`Unknown tool type "${tool.toolType}"`);
    }
    if (!RISK_LEVELS.includes(tool.riskLevel)) {
      throw new InvalidDefinitionError(`Unknown risk level "${tool.riskLevel}"`);
    }
    if ((tool.toolType === 'mcp' || tool.toolType === 'openapi') && !isHttpUrl(tool.endpoint)) {
      throw new InvalidDefinitionError(`A ${tool.toolType} tool needs an http(s) endpoint`);
    }
    if (tool.toolType === 'builtin') {
      if (tool.builtinId === undefined || !BUILTIN_TOOLS.includes(tool.builtinId)) {
        throw new InvalidDefinitionError('A builtin tool needs a known builtin_id');
      }
    }
    if (tool.toolType === 'function' && tool.parameters === undefined) {
      throw new InvalidDefinitionError('A function tool needs a parameters schema');
    }
  },
};

const promptValidator: DefinitionValidator = {
  validate(definition) {
    const prompt = definition as PromptDefinition;
    if (prompt.template.trim().length === 0) {
      throw new InvalidDefinitionError('A prompt needs a template');
    }
    // A variable the template never mentions is a promise the prompt does not
    // keep: the caller supplies it and nothing uses it.
    const missing = prompt.variables.filter(
      (variable) => !prompt.template.includes(`{{${variable}}}`),
    );
    if (missing.length > 0) {
      throw new InvalidDefinitionError(`The template never uses: ${missing.join(', ')}`);
    }
  },
};

const VALIDATORS: Record<AssetKind, DefinitionValidator> = {
  agent: agentValidator,
  tool: toolValidator,
  prompt: promptValidator,
};

export function validateDefinition(kind: AssetKind, definition: AssetDefinition): void {
  if (definition.kind !== kind) {
    throw new InvalidDefinitionError(`A ${kind} asset cannot hold a ${definition.kind} definition`);
  }
  VALIDATORS[kind].validate(definition);
}

function isHttpUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
