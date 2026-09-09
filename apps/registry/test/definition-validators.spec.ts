import { describe, expect, it } from 'vitest';

import { InvalidDefinitionError } from '../src/modules/assets/domain/errors/index.js';
import { validateDefinition } from '../src/modules/assets/domain/services/definition-validators.js';
import type {
  AgentDefinition,
  PromptDefinition,
  ToolDefinition,
} from '../src/modules/assets/domain/value-objects/index.js';

const agent = (o: Partial<AgentDefinition> = {}): AgentDefinition => ({
  kind: 'agent',
  instructions: 'Be brief.',
  modelAlias: 'chat-fast',
  tools: [],
  knowledge: [],
  ...o,
});

const tool = (o: Partial<ToolDefinition> = {}): ToolDefinition => ({
  kind: 'tool',
  toolType: 'builtin',
  riskLevel: 'low',
  builtinId: 'file_search',
  ...o,
});

describe('kind and definition must agree', () => {
  it('refuses a tool definition on an agent asset', () => {
    expect(() => {
      validateDefinition('agent', tool());
    }).toThrow(InvalidDefinitionError);
  });
});

describe('agent', () => {
  it('accepts a minimal agent', () => {
    expect(() => {
      validateDefinition('agent', agent());
    }).not.toThrow();
  });

  it('requires instructions and a model alias', () => {
    expect(() => {
      validateDefinition('agent', agent({ instructions: '  ' }));
    }).toThrow();
    expect(() => {
      validateDefinition('agent', agent({ modelAlias: '' }));
    }).toThrow();
  });

  it('bounds the sampling parameters', () => {
    expect(() => {
      validateDefinition('agent', agent({ temperature: 2.1 }));
    }).toThrow();
    expect(() => {
      validateDefinition('agent', agent({ topP: 1.5 }));
    }).toThrow();
    expect(() => {
      validateDefinition('agent', agent({ maxOutputTokens: 0 }));
    }).toThrow();
  });

  // Not an error the model would notice -- it just doubles retrieval cost on
  // every single run, silently.
  it('refuses the same store or tool attached twice', () => {
    expect(() => {
      validateDefinition('agent', agent({ knowledge: [{ storeId: 's1' }, { storeId: 's1' }] }));
    }).toThrow(InvalidDefinitionError);
    expect(() => {
      validateDefinition(
        'agent',
        agent({
          tools: [
            { assetId: 't1', version: null },
            { assetId: 't1', version: 2 },
          ],
        }),
      );
    }).toThrow(InvalidDefinitionError);
  });
});

describe('tool', () => {
  it('requires an http endpoint for mcp and openapi', () => {
    expect(() => {
      validateDefinition('tool', tool({ toolType: 'mcp' }));
    }).toThrow();
    expect(() => {
      validateDefinition('tool', tool({ toolType: 'mcp', endpoint: 'not a url' }));
    }).toThrow();
    // A non-http scheme is the interesting rejection: file:// would make the
    // gateway read the local disk.
    expect(() => {
      validateDefinition('tool', tool({ toolType: 'mcp', endpoint: 'file:///etc/passwd' }));
    }).toThrow(InvalidDefinitionError);
    expect(() => {
      validateDefinition('tool', tool({ toolType: 'mcp', endpoint: 'https://mcp.example.com' }));
    }).not.toThrow();
  });

  it('requires a known builtin id', () => {
    expect(() => {
      validateDefinition('tool', tool({ builtinId: undefined }));
    }).toThrow();
  });

  it('refuses a function tool, which the platform can never call', () => {
    // It used to publish and then fail at the gateway with "no executor is
    // configured", which reads as a deployment problem rather than as a tool
    // nothing could ever run.
    expect(() => {
      validateDefinition(
        'tool',
        tool({
          toolType: 'function' as unknown as ToolDefinition['toolType'],
          builtinId: undefined,
          parameters: { type: 'object' },
        }),
      );
    }).toThrow();
  });

  it('refuses an unknown risk level', () => {
    expect(() => {
      validateDefinition(
        'tool',
        tool({ riskLevel: 'catastrophic' as ToolDefinition['riskLevel'] }),
      );
    }).toThrow(InvalidDefinitionError);
  });
});

describe('prompt', () => {
  const prompt = (o: Partial<PromptDefinition> = {}): PromptDefinition => ({
    kind: 'prompt',
    template: 'Hello {{name}}',
    variables: ['name'],
    ...o,
  });

  it('accepts a template whose variables it uses', () => {
    expect(() => {
      validateDefinition('prompt', prompt());
    }).not.toThrow();
  });

  // A declared variable the template ignores is a promise the prompt breaks:
  // the caller supplies it and nothing happens.
  it('refuses a declared variable the template never uses', () => {
    expect(() => {
      validateDefinition('prompt', prompt({ variables: ['name', 'tone'] }));
    }).toThrow(InvalidDefinitionError);
  });

  it('refuses an empty template', () => {
    expect(() => {
      validateDefinition('prompt', prompt({ template: '  ', variables: [] }));
    }).toThrow();
  });
});
