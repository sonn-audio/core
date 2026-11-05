import assert from 'node:assert/strict';
import { sendspinCore, type SendspinSession, type SendspinSessionHooks } from '@sonn-audio/node-sendspin';
import { test } from './testHarness';
import { SendspinHookRegistry } from '../src/adapters/outputs/sendspin/sendspinHookRegistry';

/** Capture the combined hooks the registry hands node-sendspin, without a live session. */
function captureCombined(): { combined: () => SendspinSessionHooks; restore: () => void } {
  const core = sendspinCore as unknown as Record<string, unknown>;
  const savedRegister = core.registerHooks;
  const savedUnregister = core.unregisterHooks;
  let combined: SendspinSessionHooks | null = null;
  core.registerHooks = (_clientId: string, hooks: SendspinSessionHooks) => {
    combined = hooks;
  };
  core.unregisterHooks = () => {};
  return {
    combined: () => {
      assert.ok(combined, 'the registry registered nothing with node-sendspin');
      return combined;
    },
    restore: () => {
      core.registerHooks = savedRegister;
      core.unregisterHooks = savedUnregister;
    },
  };
}

test('sendspin hook registry: the rc1 session hooks reach their listeners', () => {
  const capture = captureCombined();
  try {
    const registry = new SendspinHookRegistry();
    const heard: string[] = [];
    registry.register('kitchen', {
      onPairingRequired: (_s, reason) => heard.push(`pairing:${reason}`),
      onSourceSignalChanged: (_s, signal) => heard.push(`signal:${signal}`),
      onVisualizerFormatChanged: () => heard.push('visualizer'),
      onArtworkChannelsChanged: (_s, channels) => heard.push(`artwork:${channels.length}`),
      onLeave: () => heard.push('leave'),
    });
    const hooks = capture.combined();
    const session = {} as SendspinSession;
    hooks.onPairingRequired?.(session, 'unpaired_access_disabled');
    hooks.onSourceSignalChanged?.(session, 'present' as never);
    hooks.onVisualizerFormatChanged?.(session, {} as never);
    hooks.onArtworkChannelsChanged?.(session, [{ source: 'album', format: 'jpeg', width: 300, height: 300 }]);
    hooks.onLeave?.(session);
    assert.deepEqual(heard, ['pairing:unpaired_access_disabled', 'signal:present', 'visualizer', 'artwork:1', 'leave']);
  } finally {
    capture.restore();
  }
});
