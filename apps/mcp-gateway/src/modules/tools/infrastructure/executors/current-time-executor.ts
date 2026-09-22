import { Injectable } from '@nestjs/common';

import { InvalidToolArgumentsError } from '../../domain/errors/index.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { Clock, ToolExecutor, ToolInvocation, ToolOutcome } from '../../application/ports.js';

/**
 * The `current_time` built-in.
 *
 * A model knows the world only up to its training cutoff and has no clock, so
 * "this week", "how long ago" and "is it still open" are guesses without one.
 * The time zone is resolved by the runtime's ICU data, which is why an unknown
 * name is refused rather than silently read as UTC.
 */
@Injectable()
export class CurrentTimeExecutor implements ToolExecutor {
  constructor(private readonly clock: Clock) {}

  supports(tool: ToolDefinition): boolean {
    return tool.toolType === 'builtin' && tool.builtinId === 'current_time';
  }

  async unavailableReason(): Promise<string | null> {
    return null;
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    const raw = invocation.arguments['timezone'];
    const timezone = typeof raw === 'string' ? raw.trim() : '';
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw new InvalidToolArgumentsError(invocation.tool.toolId, 'timezone must be a string');
    }

    const now = this.clock.now();
    const result: Record<string, unknown> = {
      utc: now.toISOString(),
      unix_seconds: Math.floor(now.getTime() / 1000),
      weekday_utc: partsOf(now, 'UTC').weekday,
    };

    if (timezone !== '') {
      let parts: LocalParts;
      try {
        parts = partsOf(now, timezone);
      } catch {
        throw new InvalidToolArgumentsError(
          invocation.tool.toolId,
          `"${timezone}" is not a time zone. Use an IANA name such as America/Sao_Paulo or Europe/Lisbon.`,
        );
      }
      result['timezone'] = timezone;
      result['local'] =
        `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${parts.offset}`;
      result['weekday'] = parts.weekday;
    }

    return { result, durationMs: 0 };
  }
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
  offset: string;
}

function partsOf(instant: Date, timeZone: string): LocalParts {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    format.formatToParts(instant).find((candidate) => candidate.type === type)?.value ?? '';

  // `longOffset` reads "GMT-03:00", or a bare "GMT" at offset zero.
  const offsetName = part('timeZoneName').replace('GMT', '');

  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
    weekday: part('weekday'),
    offset: offsetName === '' ? 'Z' : offsetName,
  };
}
