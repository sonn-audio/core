import { createLogger } from '@/shared/logging/logger';
import { sendspinCore } from '@sonn-audio/node-sendspin';
import type { SendspinSessionHooks } from '@sonn-audio/node-sendspin';

type HookEntry = {
  hooks: Set<SendspinSessionHooks>;
  combined: SendspinSessionHooks;
};

export type SendspinHookRegistryPort = {
  register: (clientId: string, hooks: SendspinSessionHooks) => () => void;
};

export class SendspinHookRegistry implements SendspinHookRegistryPort {
  private readonly log = createLogger('Sendspin', 'Hooks');
  private readonly entries = new Map<string, HookEntry>();

  private dispatch<K extends keyof SendspinSessionHooks>(
    clientId: string,
    key: K,
    ...args: Parameters<NonNullable<SendspinSessionHooks[K]>>
  ): void {
    const entry = this.entries.get(clientId);
    if (!entry) return;
    for (const hooks of entry.hooks) {
      const handler = hooks[key];
      if (!handler) continue;
      try {
        (handler as (...handlerArgs: typeof args) => void)(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('sendspin hook failed', { clientId, hook: key, message });
      }
    }
  }

  /**
   * The one set of hooks node-sendspin holds for this client, fanning out to every listener.
   *
   * A hook missing here is a hook nobody in core ever hears, however many listeners ask for it,
   * so a new one in node-sendspin has to be added here too. Forwarding `onLeave` also switches
   * off node-sendspin's fallback for a host without it (reporting a leave as an
   * `external_source` flap), so the outputs handle `client/leave` themselves.
   */
  private buildCombined(clientId: string): SendspinSessionHooks {
    return {
      onPlayerState: (...args) => this.dispatch(clientId, 'onPlayerState', ...args),
      onGroupCommand: (...args) => this.dispatch(clientId, 'onGroupCommand', ...args),
      onSourceState: (...args) => this.dispatch(clientId, 'onSourceState', ...args),
      onSourceCommand: (...args) => this.dispatch(clientId, 'onSourceCommand', ...args),
      onSourceAudio: (...args) => this.dispatch(clientId, 'onSourceAudio', ...args),
      onSourceStreamStart: (...args) => this.dispatch(clientId, 'onSourceStreamStart', ...args),
      onSourceStreamEnd: (...args) => this.dispatch(clientId, 'onSourceStreamEnd', ...args),
      onSourceSignalChanged: (...args) => this.dispatch(clientId, 'onSourceSignalChanged', ...args),
      onVisualizerFormatChanged: (...args) => this.dispatch(clientId, 'onVisualizerFormatChanged', ...args),
      onArtworkChannelsChanged: (...args) => this.dispatch(clientId, 'onArtworkChannelsChanged', ...args),
      onPairingRequired: (...args) => this.dispatch(clientId, 'onPairingRequired', ...args),
      onLeave: (...args) => this.dispatch(clientId, 'onLeave', ...args),
      onIdentified: (...args) => this.dispatch(clientId, 'onIdentified', ...args),
      onDisconnected: (...args) => this.dispatch(clientId, 'onDisconnected', ...args),
      onFormatChanged: (...args) => this.dispatch(clientId, 'onFormatChanged', ...args),
      onGoodbye: (...args) => this.dispatch(clientId, 'onGoodbye', ...args),
      onUnsupportedRoles: (...args) => this.dispatch(clientId, 'onUnsupportedRoles', ...args),
      onNoncompliance: (...args) => this.dispatch(clientId, 'onNoncompliance', ...args),
    };
  }

  public register(clientId: string, hooks: SendspinSessionHooks): () => void {
    const trimmed = clientId.trim();
    if (!trimmed) {
      return () => {};
    }
    let entry = this.entries.get(trimmed);
    if (!entry) {
      entry = { hooks: new Set<SendspinSessionHooks>(), combined: this.buildCombined(trimmed) };
      this.entries.set(trimmed, entry);
      sendspinCore.registerHooks(trimmed, entry.combined);
      this.log.debug('sendspin hooks activated', { clientId: trimmed });
    }
    entry.hooks.add(hooks);
    this.log.debug('sendspin hooks registered', { clientId: trimmed, listeners: entry.hooks.size });
    return () => {
      const current = this.entries.get(trimmed);
      if (!current) return;
      current.hooks.delete(hooks);
      if (current.hooks.size === 0) {
        this.entries.delete(trimmed);
        sendspinCore.unregisterHooks(trimmed);
        this.log.debug('sendspin hooks cleared', { clientId: trimmed });
        return;
      }
      this.log.debug('sendspin hooks removed', { clientId: trimmed, listeners: current.hooks.size });
    };
  }
}
