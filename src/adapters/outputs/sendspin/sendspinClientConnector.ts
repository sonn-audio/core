import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { createLogger } from '@/shared/logging/logger';
import { ConnectionReason, sendspinCore, TERMINAL_GOODBYE_REASONS } from '@sonn-audio/node-sendspin';
import type { MdnsBrowser, MdnsPort, MdnsRegistration, MdnsServiceRecord } from '@/ports/MdnsPort';

interface Endpoint {
  url: string;
  serviceName?: string;
  candidateMatch: boolean;
  reason: 'discovery' | 'playback';
  clientId?: string;
}

/**
 * Discovers Sendspin clients via mDNS and establishes outbound WebSocket connections
 * so playback can be pushed without manually starting the client with a URL.
 */
export class SendspinClientConnector {
  private readonly log = createLogger('Sendspin', 'Connector');
  private readonly desiredClientIds = new Set<string>();
  private readonly desiredReasons = new Map<string, 'discovery' | 'playback'>();
  private readonly activeSockets = new Map<string, WebSocket>();
  private readonly socketReason = new Map<string, ConnectionReason>();
  private readonly socketClientId = new Map<string, string>();
  private readonly clientSocketUrl = new Map<string, string>();
  private readonly directEndpoints = new Map<string, string>();
  private readonly configuredEndpointUrls = new Map<string, string>();
  private readonly failures = new Map<string, { count: number; lastError: string | null; suppressedUntil: number | null }>();
  private readonly lastAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly knownServices = new Map<string, MdnsServiceRecord>();
  private readonly inboundClients = new Set<string>();
  private readonly directPortFallbackTried = new Set<string>();
  private readonly resolvedClientIds = new Map<string, string>();
  private readonly resolveListeners = new Map<string, Set<(resolvedClientId: string) => void>>();
  private browser: MdnsBrowser | null = null;
  private serverRegistration: MdnsRegistration | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public watchClient(clientId: string, endpointUrl?: string): () => void {
    const normalized = clientId.trim();
    if (!normalized) {
      return () => {};
    }
    const explicitUrl = this.normalizeExplicitEndpoint(endpointUrl);
    if (explicitUrl) {
      this.configuredEndpointUrls.set(normalized, explicitUrl);
    } else {
      this.configuredEndpointUrls.delete(normalized);
    }
    this.desiredClientIds.add(normalized);
    if (!this.desiredReasons.has(normalized)) {
      this.desiredReasons.set(normalized, 'discovery');
    }
    if (this.shouldUseDirectDial(normalized)) {
      this.maybeConnectDirect(normalized);
    }
    this.ensureBrowser();
    this.retryKnownServices();
    return () => this.unwatchClient(normalized);
  }

  /** Elevate a target client to playback priority (for reclaim during active playback). */
  public requestPlaybackPriority(clientId: string): void {
    const normalized = this.resolveClientId(clientId);
    if (!normalized) {
      return;
    }
    this.desiredReasons.set(normalized, 'playback');
    const url = this.clientSocketUrl.get(normalized);
    if (url) {
      this.lastAttempts.delete(url);
    }
    if (this.shouldUseDirectDial(normalized)) {
      this.maybeConnectDirect(normalized);
    }
    this.retryKnownServices();
    // Don't force-close existing sockets just to flip the "reason"; it can race with stream start
    // and looks like a random disconnect in the client.
  }

  private unwatchClient(clientId: string): void {
    this.desiredClientIds.delete(clientId);
    this.desiredReasons.delete(clientId);
    this.resolvedClientIds.delete(clientId);
    this.resolveListeners.delete(clientId);
    this.configuredEndpointUrls.delete(clientId);
    const url = this.clientSocketUrl.get(clientId);
    if (url) {
      this.clientSocketUrl.delete(clientId);
    }
    this.directEndpoints.delete(clientId);
  }

  public resolveClientId(clientId: string): string {
    const normalized = clientId.trim();
    if (!normalized) {
      return normalized;
    }
    return this.resolvedClientIds.get(normalized) ?? normalized;
  }

  public onClientResolved(clientId: string, cb: (resolvedClientId: string) => void): () => void {
    const normalized = clientId.trim();
    if (!normalized) {
      return () => {};
    }
    let set = this.resolveListeners.get(normalized);
    if (!set) {
      set = new Set();
      this.resolveListeners.set(normalized, set);
    }
    set.add(cb);
    const resolved = this.resolvedClientIds.get(normalized);
    if (resolved) {
      cb(resolved);
    }
    return () => {
      const listeners = this.resolveListeners.get(normalized);
      if (!listeners) {
        return;
      }
      listeners.delete(cb);
      if (!listeners.size) {
        this.resolveListeners.delete(normalized);
      }
    };
  }

  private updateResolvedClientId(configuredClientId: string, resolvedClientId: string): void {
    const configured = configuredClientId.trim();
    const resolved = resolvedClientId.trim();
    if (!configured || !resolved) {
      return;
    }
    const prev = this.resolvedClientIds.get(configured);
    if (prev === resolved) {
      return;
    }
    this.resolvedClientIds.set(configured, resolved);
    if (!this.desiredClientIds.has(resolved)) {
      this.desiredClientIds.add(resolved);
      const configuredReason = this.desiredReasons.get(configured);
      if (configuredReason && !this.desiredReasons.has(resolved)) {
        this.desiredReasons.set(resolved, configuredReason);
      }
    }
    const listeners = this.resolveListeners.get(configured);
    if (listeners?.size) {
      for (const listener of listeners) {
        try {
          listener(resolved);
        } catch {
          // Ignore listener failures.
        }
      }
    }
  }

  public advertiseServer(options: { port: number; host?: string; name?: string; path?: string }): void {
    this.stopAdvertising();
    this.serverRegistration = this.mdns.publish({
      name: options.name || 'Lox Audio Server',
      type: 'sendspin-server',
      protocol: 'tcp',
      port: options.port,
      host: options.host,
      txt: { path: this.normalizePathValue(options.path) },
    });
    this.log.info('Sendspin server advertised via mDNS', {
      name: options.name || 'Lox Audio Server',
      host: options.host,
      port: options.port,
      path: this.normalizePathValue(options.path),
    });
  }

  public stopAdvertising(): void {
    this.serverRegistration?.stop();
    this.serverRegistration = null;
  }

  private ensureBrowser(): void {
    if (this.browser) {
      return;
    }
    this.browser = this.mdns.browse(
      { type: 'sendspin', protocol: 'tcp' },
      (service) => this.handleService(service),
    );
  }

  private retryKnownServices(): void {
    for (const service of this.knownServices.values()) {
      this.handleService(service);
    }
  }

  private handleService(service: MdnsServiceRecord): void {
    const key = this.serviceKey(service);
    this.knownServices.set(key, service);
    if (!this.desiredClientIds.size) {
      return;
    }

    const matchedClientId = [...this.desiredClientIds].find((id) => this.serviceMatches(service, id));
    if (!matchedClientId) {
      return;
    }

    const endpoint = this.toEndpoint(service, matchedClientId);
    if (endpoint) {
      this.connect(endpoint);
    }
  }

  private connect(endpoint: Endpoint): void {
    if (this.activeSockets.has(endpoint.url)) {
      return;
    }
    if (endpoint.clientId && this.inboundClients.has(endpoint.clientId)) {
      return;
    }
    if (!this.desiredClientIds.size) {
      return;
    }

    const now = Date.now();
    const failureMeta = this.failures.get(endpoint.url);
    if (failureMeta?.suppressedUntil && now < failureMeta.suppressedUntil) {
      return;
    }
    const lastAttempt = this.lastAttempts.get(endpoint.url) ?? 0;
    const minIntervalMs = endpoint.reason === 'playback' ? 0 : 3_000;
    if (now - lastAttempt < minIntervalMs) {
      return;
    }
    this.lastAttempts.set(endpoint.url, now);

    if (endpoint.clientId) {
      const existingUrl = this.clientSocketUrl.get(endpoint.clientId);
      if (existingUrl && this.activeSockets.has(existingUrl) && existingUrl !== endpoint.url) {
        // Already connected to this client id.
        return;
      }
    }

    this.log.info('Sendspin dialing client', {
      url: endpoint.url,
      service: endpoint.serviceName,
    });

    let upgradeReq: IncomingMessage | null = null;
    let matchedDesired = false;
    const ws = new WebSocket(endpoint.url);
    ws.on('upgrade', (req) => {
      upgradeReq = req;
    });

    ws.once('open', () => {
      this.activeSockets.set(endpoint.url, ws);
      const reason =
        endpoint.reason === 'playback' ? ConnectionReason.PLAYBACK : ConnectionReason.DISCOVERY;
      this.socketReason.set(endpoint.url, reason);
      // Pass the intended connection reason to the session.
      sendspinCore.handleConnection(ws, upgradeReq, reason);
    });

    ws.on('message', (data, isBinary) => {
      if (matchedDesired || isBinary) {
        return;
      }
      const clientId = this.extractClientId(data);
      if (!clientId) {
        return;
      }
      const configuredId = endpoint.clientId?.trim() || null;
      const configuredDesired = configuredId ? this.desiredClientIds.has(configuredId) : false;
      const exactDesired = this.desiredClientIds.has(clientId);
      if (configuredId && configuredDesired && configuredId !== clientId) {
        this.updateResolvedClientId(configuredId, clientId);
        this.log.info('Sendspin client resolved from configured id', {
          configuredClientId: configuredId,
          resolvedClientId: clientId,
          url: endpoint.url,
        });
      }
      matchedDesired = exactDesired || configuredDesired;
      if (!matchedDesired) {
        this.log.info('Sendspin client not in config; closing connection', {
          clientId,
          url: endpoint.url,
        });
        ws.close();
        return;
      }
      this.log.info('Sendspin client connected', { clientId, url: endpoint.url });
      this.socketClientId.set(endpoint.url, clientId);

      // If we already had another socket for this clientId, close it in favor of the newest one.
      const prior = this.clientSocketUrl.get(clientId);
      if (prior && prior !== endpoint.url) {
        this.activeSockets.get(prior)?.close();
      }
      this.clientSocketUrl.set(clientId, endpoint.url);
      if (configuredId) {
        const priorConfigured = this.clientSocketUrl.get(configuredId);
        if (priorConfigured && priorConfigured !== endpoint.url) {
          this.activeSockets.get(priorConfigured)?.close();
        }
        this.clientSocketUrl.set(configuredId, endpoint.url);
      }

      // Do not disconnect solely to "upgrade" the connection reason.
    });

    ws.on('close', (_code, reasonBuf) => {
      this.activeSockets.delete(endpoint.url);
      this.socketReason.delete(endpoint.url);
      const knownClientId = this.socketClientId.get(endpoint.url);
      if (knownClientId) {
        this.socketClientId.delete(endpoint.url);
        if (this.clientSocketUrl.get(knownClientId) === endpoint.url) {
          this.clientSocketUrl.delete(knownClientId);
        }
        for (const [configuredId, resolvedId] of this.resolvedClientIds.entries()) {
          if (resolvedId === knownClientId && this.clientSocketUrl.get(configuredId) === endpoint.url) {
            this.clientSocketUrl.delete(configuredId);
          }
        }
      }
      const reason = reasonBuf ? reasonBuf.toString() : '';
      const goodbyeReason = this.parseGoodbyeReason(reason);
      const shouldRetry =
        (matchedDesired || endpoint.candidateMatch) &&
        !this.shouldSuppressRetry(goodbyeReason);
      this.scheduleRetry(endpoint, shouldRetry);
    });

    ws.on('error', (err) => {
      this.log.debug('Sendspin socket error', {
        url: endpoint.url,
        message: (err as Error).message,
      });
      this.recordFailure(endpoint, (err as Error).message);
    });
  }

  private scheduleRetry(endpoint: Endpoint, shouldRetry: boolean): void {
    if (!shouldRetry || !this.desiredClientIds.size) {
      return;
    }
    if (endpoint.clientId && this.inboundClients.has(endpoint.clientId)) {
      return;
    }
    if (this.retryTimers.has(endpoint.url)) {
      return;
    }

    // If a direct endpoint on 8927 is refusing connections, try the spec default 8928 once.
    const fallback = this.maybeFallbackDirectPort(endpoint);
    if (fallback) {
      this.connect(fallback);
      return;
    }

    const delayMs = endpoint.reason === 'playback' ? 500 : 5_000;
    const failureMeta = this.failures.get(endpoint.url);
    const suppressedUntil = failureMeta?.suppressedUntil ?? null;
    if (suppressedUntil && Date.now() < suppressedUntil) {
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(endpoint.url);
      const failureMeta = this.failures.get(endpoint.url);
      if (failureMeta?.suppressedUntil && Date.now() < failureMeta.suppressedUntil) {
        return;
      }
      this.connect(endpoint);
    }, delayMs);
    this.retryTimers.set(endpoint.url, timer);
  }

  private recordFailure(endpoint: Endpoint, message: string | null): void {
    const url = endpoint.url;
    const meta = this.failures.get(url) ?? { count: 0, lastError: null, suppressedUntil: null };
    const nextCount = (meta.count || 0) + 1;
    const normalizedMsg = message ? message.toLowerCase() : null;
    let suppressedUntil: number | null = meta.suppressedUntil ?? null;
    // If DNS lookup failed repeatedly, back off longer to avoid log spam.
    if (normalizedMsg && normalizedMsg.includes('enotfound') && nextCount >= 3) {
      suppressedUntil = Date.now() + 60_000; // 60s suppression
      this.log.info('Sendspin direct endpoint suppressed after repeated DNS failures', {
        url,
        attempts: nextCount,
        retryAfterMs: 60_000,
      });
    }
    this.failures.set(url, { count: nextCount, lastError: message, suppressedUntil });
  }

  private extractClientId(raw: RawData): string | null {
    try {
      const msg = JSON.parse(raw.toString());
      return msg?.payload?.client_id || msg?.payload?.clientId || null;
    } catch {
      return null;
    }
  }

  private toEndpoint(service: MdnsServiceRecord, clientId: string): Endpoint | null {
    const address = this.pickAddress(service);
    if (!address || !service.port) {
      this.log.debug('Sendspin mDNS entry missing address/port', { service: service.name });
      return null;
    }
    const path = this.normalizePathFromTxt(service.txt);
    const hostFmt = address.includes(':') ? `[${address}]` : address;
    const url = `ws://${hostFmt}:${service.port}${path}`;
    return {
      url,
      serviceName: service.name,
      candidateMatch: true,
      reason: this.desiredReasons.get(clientId) ?? 'discovery',
      clientId,
    };
  }

  private maybeConnectDirect(clientId: string): void {
    if (!this.shouldUseDirectDial(clientId)) {
      return;
    }
    const endpoint = this.buildDirectEndpoint(clientId);
    if (!endpoint) {
      return;
    }
    this.directEndpoints.set(clientId, endpoint.url);
    this.connect(endpoint);
  }

  private buildDirectEndpoint(clientId: string): Endpoint | null {
    const reason = this.desiredReasons.get(clientId) ?? 'discovery';
    const trimmed = clientId.trim();
    if (!trimmed) {
      return null;
    }
    const explicit = this.configuredEndpointUrls.get(trimmed);
    if (explicit) {
      return {
        url: explicit,
        serviceName: 'configured-endpoint',
        candidateMatch: true,
        reason,
        clientId: trimmed,
      };
    }

    // If a full WebSocket URL is provided, use it verbatim.
    const hasScheme = /^wss?:\/\//i.test(trimmed);
    let url = trimmed;

    if (!hasScheme) {
      const hostPort = trimmed.includes(':') ? trimmed : `${trimmed}:8927`;
      const parts = hostPort.split(':');
      const host = parts.slice(0, -1).join(':') || hostPort;
      const port = parts.length > 1 ? parts[parts.length - 1] : '8927';
      const hostFmt = host.includes(':') ? `[${host}]` : host;
      url = `ws://${hostFmt}:${port}/sendspin`;
    }

    try {
      // Validate URL; will throw if invalid.

      new URL(url);
    } catch {
      return null;
    }

    return {
      url,
      serviceName: 'direct',
      candidateMatch: true,
      reason,
      clientId: trimmed,
    };
  }

  private pickAddress(service: MdnsServiceRecord): string | null {
    const addresses = (service.addresses || []).filter(Boolean) as string[];
    const ipv4 = addresses.find((addr) => addr.includes('.'));
    if (ipv4) {
      return ipv4;
    }
    if (service.host) {
      return service.host;
    }
    if (service.name) {
      return service.name;
    }
    return null;
  }

  private normalizePathFromTxt(txt?: Record<string, unknown>): string {
    return this.normalizePathValue(typeof txt?.path === 'string' ? txt.path : undefined);
  }

  private normalizePathValue(path?: string): string {
    const raw = path || '/sendspin';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  private normalizeExplicitEndpoint(endpointUrl?: string): string | null {
    const raw = typeof endpointUrl === 'string' ? endpointUrl.trim() : '';
    if (!raw) {
      return null;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return null;
      }
      const path = parsed.pathname || '/sendspin';
      parsed.pathname = path.startsWith('/') ? path : `/${path}`;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  /**
   * Use direct dialing only when the config explicitly looks like an endpoint/host target.
   * For plain Sendspin client IDs (e.g. "sendspin-cli-Mac"), rely on mDNS discovery.
   */
  private shouldUseDirectDial(clientId: string): boolean {
    const trimmed = clientId.trim();
    if (!trimmed) {
      return false;
    }
    if (this.configuredEndpointUrls.has(trimmed)) {
      return true;
    }
    if (/^wss?:\/\//i.test(trimmed)) {
      return true;
    }
    // Explicit host:port (or [ipv6]:port) should still dial directly.
    if (/^\[[^\]]+\]:\d+$/.test(trimmed)) {
      return true;
    }
    if (/^[^:\s]+:\d+$/.test(trimmed)) {
      return true;
    }
    // Plain IPv4 literal; default port/path direct dialing is reasonable.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
      return true;
    }
    // Otherwise treat as logical Sendspin client id and wait for mDNS endpoint.
    return false;
  }

  private serviceMatches(service: MdnsServiceRecord, clientId: string): boolean {
    const id = clientId.toLowerCase();
    const values = [
      service.name,
      service.host,
      ...(service.addresses || []),
    ]
      .filter(Boolean)
      .map((v) => (v as string).toLowerCase());
    return values.some((val) => val === id || val.startsWith(id) || id.startsWith(val));
  }

  private serviceKey(service: MdnsServiceRecord): string {
    return `${service.name || service.host || 'unknown'}:${service.port}`;
  }

  public markInboundConnected(clientId: string): void {
    const normalized = clientId.trim();
    if (!normalized) {
      return;
    }
    this.inboundClients.add(normalized);
  }

  /**
   * The client's live session ended. Dial it again unless it said not to.
   *
   * Nothing else would: when our own socket to it closes, that close is handled while the
   * session still counts as connected, so `scheduleRetry` stands down, and mDNS stays quiet
   * when the client comes back with an unchanged record. A client that restarted mid-playback
   * was then only reached again after a server restart.
   */
  public markInboundDisconnected(clientId: string, goodbyeReason?: string | null): void {
    const normalized = clientId.trim();
    if (!normalized) {
      return;
    }
    this.inboundClients.delete(normalized);
    if (this.shouldSuppressRetry(goodbyeReason ?? null)) {
      return;
    }
    this.redial(normalized);
  }

  /** Dial every endpoint known for a watched client now, past the attempt interval. */
  private redial(clientId: string): void {
    const ids = new Set<string>();
    if (this.desiredClientIds.has(clientId)) {
      ids.add(clientId);
    }
    for (const [configuredId, resolvedId] of this.resolvedClientIds.entries()) {
      if (resolvedId === clientId && this.desiredClientIds.has(configuredId)) {
        ids.add(configuredId);
      }
    }
    const endpoints = new Map<string, Endpoint>();
    for (const id of ids) {
      const direct = this.shouldUseDirectDial(id) ? this.buildDirectEndpoint(id) : null;
      if (direct) {
        this.directEndpoints.set(id, direct.url);
        endpoints.set(direct.url, direct);
      }
      for (const service of this.knownServices.values()) {
        const endpoint = this.serviceMatches(service, id) ? this.toEndpoint(service, id) : null;
        if (endpoint && !endpoints.has(endpoint.url)) {
          endpoints.set(endpoint.url, endpoint);
        }
      }
    }
    for (const endpoint of endpoints.values()) {
      this.lastAttempts.delete(endpoint.url);
      this.connect(endpoint);
    }
  }

  private parseGoodbyeReason(reason: string): string | null {
    const prefix = 'client goodbye:';
    if (!reason || !reason.startsWith(prefix)) {
      return null;
    }
    return reason.slice(prefix.length).trim() || null;
  }

  /**
   * Whether a goodbye means reconnecting is pointless.
   *
   * The client is telling us it will not accept this server as it stands, so a retry
   * just earns the same refusal. `restart` is deliberately not in the list — a
   * restarting client is expected back.
   */
  private shouldSuppressRetry(reason: string | null): boolean {
    if (!reason) {
      return false;
    }
    return (TERMINAL_GOODBYE_REASONS as readonly string[]).includes(reason);
  }

  private maybeFallbackDirectPort(endpoint: Endpoint): Endpoint | null {
    if (!endpoint.clientId) {
      return null;
    }
    if (endpoint.serviceName !== 'direct') {
      return null;
    }
    const failure = this.failures.get(endpoint.url);
    const msg = (failure?.lastError ?? '').toLowerCase();
    if (!msg.includes('econnrefused')) {
      return null;
    }

    // Only attempt the fallback once per client id.
    const key = endpoint.clientId;
    if (this.directPortFallbackTried.has(key)) {
      return null;
    }

    // Convert ws://host:8927/sendspin -> ws://host:8928/sendspin
    if (!endpoint.url.includes(':8927/')) {
      return null;
    }
    const fallbackUrl = endpoint.url.replace(':8927/', ':8928/');
    if (fallbackUrl === endpoint.url) {
      return null;
    }

    this.directPortFallbackTried.add(key);
    this.lastAttempts.delete(fallbackUrl);
    return {
      ...endpoint,
      url: fallbackUrl,
      serviceName: 'direct-fallback',
    };
  }
}
