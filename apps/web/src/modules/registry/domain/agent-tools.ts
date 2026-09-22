/**
 * The tools and stores an agent carries, as the editor shows and saves them.
 *
 * The form used to send `tools: []` and `knowledge: []` on every save, so an
 * agent whose tools were attached through the API lost them the first time
 * somebody fixed a typo in its instructions. What the editor does not show, it
 * still has to carry back.
 */

export interface ToolReference {
  readonly assetId: string;
  /** Null follows whatever is published when a run starts. */
  readonly version: number | null;
}

export interface StoreReference {
  readonly storeId: string;
}

/** A tool the project may invoke, as far as the editor needs to know it. */
export interface AttachableTool {
  readonly toolId: string;
  readonly name: string;
  readonly description?: string;
  readonly source: 'registry' | 'platform';
  readonly riskLevel: 'low' | 'medium' | 'high';
}

export interface ToolChoice {
  readonly toolId: string;
  readonly name: string;
  readonly description?: string;
  /** Absent for an attachment the project can no longer run. */
  readonly source?: 'registry' | 'platform';
  readonly riskLevel?: 'low' | 'medium' | 'high';
  readonly attached: boolean;
  readonly available: boolean;
}

export function toolChoices(
  attachable: readonly AttachableTool[],
  attached: readonly ToolReference[],
): ToolChoice[] {
  const attachedIds = new Set(attached.map((reference) => reference.assetId));
  const offered = new Set(attachable.map((tool) => tool.toolId));

  return [
    ...attachable.map((tool) => ({
      toolId: tool.toolId,
      name: tool.name,
      ...(tool.description !== undefined && { description: tool.description }),
      source: tool.source,
      riskLevel: tool.riskLevel,
      attached: attachedIds.has(tool.toolId),
      available: true,
    })),
    // Still shown, and still ticked. Dropping it here would remove it from the
    // agent on the next save without anyone deciding to -- and whoever is
    // looking needs to see that the agent is attached to something that will
    // not run, to switch it back on or untick it deliberately.
    ...attached
      .filter((reference) => !offered.has(reference.assetId))
      .map((reference) => ({
        toolId: reference.assetId,
        name: reference.assetId,
        attached: true,
        available: false,
      })),
  ];
}

/**
 * The references to save, from what was ticked.
 *
 * A version pin survives the edit: only a tool attached just now starts
 * unpinned. The same id ticked twice is saved once -- the registry refuses a
 * duplicate, and the person would not know why.
 */
export function toolReferencesFor(
  selected: readonly string[],
  previous: readonly ToolReference[],
): ToolReference[] {
  const pinned = new Map(previous.map((reference) => [reference.assetId, reference.version]));
  const ids = [...new Set(selected.map((id) => id.trim()).filter((id) => id !== ''))];
  return ids.map((assetId) => ({ assetId, version: pinned.get(assetId) ?? null }));
}

/**
 * References the form carried back in a hidden field.
 *
 * The field comes from the browser, so anything that is not the shape the page
 * rendered is dropped rather than trusted. The registry validates again on
 * save; this only keeps a mangled field from reaching it as an exception.
 */
export function parseToolReferences(raw: string): ToolReference[] {
  return entriesOf(raw).flatMap((entry) => {
    const assetId = entry['assetId'];
    const version = entry['version'];
    if (typeof assetId !== 'string' || assetId === '') return [];
    return [
      {
        assetId,
        version:
          typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : null,
      },
    ];
  });
}

export function parseStoreReferences(raw: string): StoreReference[] {
  return entriesOf(raw).flatMap((entry) => {
    const storeId = entry['storeId'];
    return typeof storeId === 'string' && storeId !== '' ? [{ storeId }] : [];
  });
}

function entriesOf(raw: string): Record<string, unknown>[] {
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

export interface PlaygroundContext {
  /** Which version a run executes, and what it may call. */
  readonly runs: string;
  /** Set when what is being edited is not what runs. */
  readonly warning?: string;
}

/**
 * What the Playground says about the agent it runs.
 *
 * A run always resolves the PUBLISHED version. Left unsaid, somebody ticks a
 * tool, saves the draft, asks the Playground -- and gets the old agent, which,
 * with no tools, answers that it cannot reach the web. Both halves of that are
 * worth a sentence: which version runs, and what it is able to call.
 */
export function playgroundContext(input: {
  liveVersion: number;
  liveToolNames: readonly string[];
  hasUnpublishedChanges: boolean;
}): PlaygroundContext {
  const tools =
    input.liveToolNames.length === 0
      ? 'no tools, so it cannot search the web or call anything'
      : `tools: ${input.liveToolNames.join(', ')}`;

  return {
    runs: `Runs published v${input.liveVersion.toString()}, with ${tools}.`,
    ...(input.hasUnpublishedChanges && {
      warning: 'The draft has changes that are not published. Publish to try them here.',
    }),
  };
}
