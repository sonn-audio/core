import type { CommandResult } from '@/adapters/loxone/commands/types';

/**
 * Creates a standard JSON response (with `<name>_result` wrapping).
 */
export function buildResponse(
  command: string,
  name: string,
  payload: CommandResult['payload'],
): CommandResult {
  return { command, name, payload };
}

/**
 * Builds an empty response for unknown or intentionally silent commands.
 */
export function buildEmptyResponse(command: string): CommandResult {
  return {
    command,
    name: inferResultName(command),
    payload: [],
  };
}

/**
 * Serializes a CommandResult in the wire format expected by Loxone clients.
 */
export function serializeResult(result: CommandResult): string {
  if (result.raw) {
    return typeof result.payload === 'string'
      ? result.payload
      : JSON.stringify(result.payload);
  }

  return JSON.stringify(
    {
      [`${result.name}_result`]: result.payload,
      command: result.command,
    },
    null,
    2,
  );
}

function inferResultName(command: string): string {
  const parts = (command ?? '').split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts[i];
    if (candidate && /^[a-z]/i.test(candidate)) {
      return candidate;
    }
  }
  return 'response';
}
