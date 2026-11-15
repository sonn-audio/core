import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import { decodeSegment, parseNumberPart, splitCommand } from '@/adapters/loxone/commands/utils/commandUtils';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { AudioServerConfig, LineInInputConfig } from '@/domain/config/types';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { ConfigPort } from '@/ports/ConfigPort';

const DEFAULT_ICON_TYPE = 0;

type LineInDeps = {
  lineIn: LineInActivationService;
  notifier: LoxoneWsNotifier;
};

/**
 * Loxone's line-in commands. Everything here is protocol: pulling ids out of a
 * command string and shaping the response. Actually selecting a line-in — and the
 * zone bookkeeping that goes with it — belongs to LineInActivationService, which
 * outlives any one Loxone connection and is shared with the other adapters.
 */
export function createInputHandlers(configPort: ConfigPort, deps: LineInDeps) {
  return {
    audioCfgGetInputs: (command: string) => audioCfgGetInputs(deps, command),
    audioCfgInputRename: (command: string) => audioCfgInputRename(configPort, deps, command),
    audioCfgInputType: (command: string) => audioCfgInputType(configPort, deps, command),
    audioLineIn: (command: string) => audioLineIn(deps, command),
  };
}

function getMutableLineInInputs(config: AudioServerConfig): LineInInputConfig[] {
  if (!config.inputs) {
    config.inputs = {};
  }
  if (!config.inputs.lineIn) {
    config.inputs.lineIn = { inputs: [] };
  }
  if (!Array.isArray(config.inputs.lineIn.inputs)) {
    config.inputs.lineIn.inputs = [];
  }
  return config.inputs.lineIn.inputs;
}

export function audioCfgGetInputs(deps: LineInDeps, command: string) {
  const inputs = deps.lineIn.listLineInInputs().map((item) => ({
    cmd: 'linein',
    description: '',
    id: item.id,
    name: item.name,
    icontype: item.iconType,
    type: 6,
  }));
  return buildResponse(command, 'getinputs', inputs);
}

export async function audioCfgInputRename(configPort: ConfigPort, deps: LineInDeps, command: string) {
  const parts = splitCommand(command);
  const inputId = decodeInputId(decodeSegment(parts[3] ?? ''));
  const nextName = decodeSegment(parts[5] ?? '').trim();

  if (!inputId) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  const index = deps.lineIn.findLineInIndexById(inputId);
  if (index === null) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  await configPort.updateConfig((cfg) => {
    const inputs = getMutableLineInInputs(cfg);
    const current = (inputs[index] ?? {}) as LineInInputConfig;
    const updated: LineInInputConfig = { ...current };
    if (nextName) {
      updated.name = nextName;
    } else {
      delete updated.name;
    }
    inputs[index] = updated;
  });

  deps.notifier.notifyLineInChanged();
  return buildResponse(command, 'input', [{ action: 'ok' }]);
}

export async function audioCfgInputType(configPort: ConfigPort, deps: LineInDeps, command: string) {
  const parts = splitCommand(command);
  const inputId = decodeInputId(decodeSegment(parts[3] ?? ''));
  const iconRaw = decodeSegment(parts[5] ?? '');
  const iconType = Number(iconRaw);

  if (!inputId) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  const index = deps.lineIn.findLineInIndexById(inputId);
  if (index === null) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  if (Number.isFinite(iconType)) {
    await configPort.updateConfig((cfg) => {
      const inputs = getMutableLineInInputs(cfg);
      const current = (inputs[index] ?? {}) as LineInInputConfig;
      inputs[index] = { ...current, iconType };
    });
    deps.notifier.notifyLineInChanged();
  }

  return buildResponse(command, 'input', [{ action: 'ok' }]);
}

function audioLineIn(deps: LineInDeps, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const rawId = parts[3] ?? parts[2] ?? '';
  const rawValue = extractLineInValue(rawId);
  const inputId = decodeInputId(rawValue);

  if (!zoneId) {
    return buildEmptyResponse(command);
  }

  // The Loxone client sometimes sends `linein1`/`1` instead of a real id, so fall
  // back to position. This stays here rather than in the service: an HTTP caller
  // passing a bad id should get an error, not silently start input #1.
  const resolvedId = inputId || rawValue || '1';
  const resolvedInputs = deps.lineIn.listLineInInputs();
  let selected = resolvedInputs.find((entry) => entry.id === resolvedId);
  if (!selected && /^\d+$/.test(resolvedId)) {
    const idx = Number(resolvedId) - 1;
    if (idx >= 0 && idx < resolvedInputs.length) {
      selected = resolvedInputs[idx];
    }
  }

  // Pass the name we already resolved: the service would fall back to the
  // no-signal title, but this client expects its own LineIn1 default.
  const title = selected?.name ?? (resolvedInputs[0]?.name ?? 'LineIn1');
  const audiopath = selected?.id ?? resolvedId;
  const iconType = selected?.iconType ?? DEFAULT_ICON_TYPE;

  deps.lineIn.activateLineIn(zoneId, audiopath, { title, iconType });
  return buildResponse(command, 'linein', { action: 'play' });
}

function extractLineInValue(rawId: string): string {
  if (typeof rawId !== 'string') {
    return rawId as unknown as string;
  }
  const lowered = rawId.toLowerCase();
  if (!lowered.startsWith('linein')) {
    return rawId;
  }
  const candidate = rawId.slice('linein'.length);
  return /^\d+$/.test(candidate) ? candidate : rawId;
}

function decodeInputId(raw: string): string {
  if (!raw) {
    return '';
  }
  const table: Record<string, string> = {
    '-': '+',
    _: '/',
  };
  try {
    const decoded = Buffer.from(raw.replace(/[-_]/g, (str) => table[str] ?? str), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch {
    // ignore
  }
  return raw;
}
