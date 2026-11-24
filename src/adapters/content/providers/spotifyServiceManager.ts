import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentServiceAccount,
  PlaylistEntry,
  SpotifyAccountConfig,
  StreamingServiceConfig,
} from '@/ports/ContentTypes';
import {
  SpotifyAccountProvider,
  type PersistAccountCallback,
  type SpotifyAccountState,
} from '@/adapters/content/providers/spotify/spotifyAccountProvider';
import { FakeSpotifyAccountProvider } from '@/adapters/content/providers/spotify/fakeSpotifyAccountProvider';
import type { ContentProvider } from '@/adapters/content/ContentProvider';
import { providerDefinition, providerIcon, providerTitle } from '@/adapters/content/providerRegistry';
import { resolveSpotifyClientId } from '@/adapters/content/providers/spotify/utils';
import { parseSearchLimits } from '@/adapters/content/utils/searchLimits';
import { resolveCoverHost } from '@/shared/utils/net';
import { serviceNativeKey, slugFromBridgeId } from '@/domain/media/serviceIdentity';

type ProviderId = string;
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

export interface SpotifyServiceDevice {
  id: string;
  name: string;
  type?: string;
  isActive?: boolean;
  volumePercent?: number;
  supportsVolume?: boolean;
  accountId: string;
  accountLabel: string;
  providerId: string;
}

/**
 * Manages Spotify accounts and exposes simple helpers for folder/playlist lookups.
 */
export class SpotifyServiceManager {
  private readonly log = createLogger('Content', 'SpotifyManager');
  private readonly configPort: ConfigPort;

  private providers = new Map<
    ProviderId,
    ContentProvider
  >();

  private accounts: SpotifyAccountState[] = [];
  private bridges: StreamingServiceConfig[] = [];
  private clientId = resolveSpotifyClientId();

  constructor(
    configPort: ConfigPort,
    accounts: SpotifyAccountConfig[] = [],
    clientId?: string,
    bridges: StreamingServiceConfig[] = [],
  ) {
    this.configPort = configPort;
    this.reload(accounts, clientId, bridges);
  }

  /**
   * Rebuild all account providers from config.
   */
  public reload(
    accounts: SpotifyAccountConfig[] = [],
    clientId?: string,
    bridges: StreamingServiceConfig[] = [],
  ): void {
    // Keep the previous instances so unchanged accounts can be REUSED rather than
    // recreated. Recreating a Spotify provider mid-startup spawns a second token
    // refresh with the same refresh token; Spotify's rotation reuse-detection then
    // treats it as a replay and revokes the whole token family — which forced a
    // re-link on (almost) every restart, since the manager reloads twice on boot.
    const previous = new Map(this.providers);
    this.providers.clear();
    this.clientId = resolveSpotifyClientId({ clientId });
    this.bridges = Array.isArray(bridges) ? [...bridges] : [];
    this.accounts = (accounts ?? []).map((acc, idx) => ({
      ...acc,
      // normalize alternative refresh_token key if present
      refreshToken: acc.refreshToken ?? (acc as { refresh_token?: string }).refresh_token,
      id: acc.id || acc.user || acc.email || `user${idx + 1}`,
    }));

    for (const account of this.accounts) {
      const providerId = this.providerIdFor(account.id);
      const existing = previous.get(providerId);
      // Reuse only when the account is genuinely unchanged (same refresh token):
      // that preserves the in-flight refresh / single-flight and rotated token.
      // A different token means a fresh link → recreate.
      if (
        existing instanceof SpotifyAccountProvider &&
        existing.configuredRefreshToken === (account.refreshToken ?? undefined)
      ) {
        this.providers.set(providerId, existing);
        previous.delete(providerId); // reused → don't dispose below
        continue;
      }
      const provider = new SpotifyAccountProvider({
        providerId,
        account,
        clientId: account.clientId ?? this.clientId,
        persistAccount: this.persistAccountState,
      });
      this.providers.set(providerId, provider);
    }

    // Dispose providers that were not reused (removed/relinked accounts, old bridges).
    for (const provider of previous.values()) {
      (provider as { dispose?: () => void })?.dispose?.();
    }

    this.registerBridgeProviders();

    this.log.debug('spotify manager reloaded', { accounts: this.accounts.length });
  }

  /**
   * List all available spotify accounts (including optional bridge/fake accounts).
   */
  public listAccounts(): ContentServiceAccount[] {
    const realAccounts: ContentServiceAccount[] = this.accounts.map((acc) => ({
      id: this.providerIdFor(acc.id),
      label: acc.displayName || acc.name || acc.user || acc.email || acc.id,
      provider: 'spotify',
      fake: false,
      product: acc.product,
    }));

    const fakeAccounts: ContentServiceAccount[] = (this.bridges ?? [])
      .filter((bridge) => bridge && bridge.enabled !== false)
      .map((bridge) => ({
        id: this.bridgeProviderId(bridge),
        // Expose provider as the name for bridge accounts (e.g., MusicAssistant).
        label: bridge.provider || bridge.label || bridge.id,
        provider: (bridge.provider || 'spotify').toLowerCase(),
        fake: true,
      }));

    return [...realAccounts, ...fakeAccounts];
  }

  /**
   * Legacy-style service entries for Loxone getservices.
   */
  public listServiceEntries(): Array<Record<string, unknown>> {
    const entries = this.accounts.map((acc) => {
      const provider = this.providers.get(this.providerIdFor(acc.id));
      return {
        cmd: 'spotify',
        name: providerTitle('spotify'),
        icon: providerIcon('spotify'),
        id: acc.id || acc.user || acc.email || '',
        user: this.displayLabel(acc),
        email: acc.email ?? '',
        product: acc.product ?? '',
        asdefault: [],
        offline_storage: [],
        configerror: (provider as SpotifyAccountProvider | undefined)?.hasAuthError ?? false,
        provider: 'spotify',
        fake: false,
      };
    });

    for (const bridge of (this.bridges ?? []).filter((b) => b && b.enabled !== false)) {
      const providerId = this.bridgeProviderId(bridge);
      const provider = this.providers.get(providerId);
      const providerType = (bridge.provider || 'spotify').toLowerCase();
      const email = `${(bridge.id || '').trim()}@sonn-core.io`;
      entries.push({
        cmd: 'spotify',
        // For bridges, omit the friendly name; clients can display sourceName/provider instead.
        name: '',
        icon: providerIcon(providerType),
        id: bridge.id,
        user: bridge.label || bridge.id,
        email: email || '',
        product: '',
        asdefault: [],
        offline_storage: [],
        configerror: (provider as SpotifyAccountProvider | undefined)?.hasAuthError ?? false,
        provider: providerType,
        fake: true,
      });
    }

    return entries;
  }

  /**
   * Aggregate Spotify Connect devices across all configured Spotify accounts.
   */
  public async listConnectDevices(): Promise<SpotifyServiceDevice[]> {
    const devices: SpotifyServiceDevice[] = [];
    for (const provider of this.providers.values()) {
      if (!this.isRealSpotifyProvider(provider)) {
        this.log.debug('bridge provider skipped for spotify connect devices', {
          provider: provider?.providerId,
        });
        continue;
      }
      try {
        const accountDevices = await provider.listConnectDevices();
        for (const device of accountDevices) {
          if (!device.id || !device.name) {
            continue;
          }
          devices.push({
            id: device.id,
            name: device.name,
            type: device.type,
            isActive: device.isActive ?? false,
            volumePercent: device.volumePercent,
            supportsVolume: device.supportsVolume ?? false,
            accountId: provider.accountId,
            accountLabel: provider.displayLabel,
            providerId: provider.providerId,
          });
        }
      } catch (err) {
        this.log.warn('spotify connect device listing failed', {
          provider: provider.providerId,
          err,
        });
      }
    }
    const unique = new Map<string, SpotifyServiceDevice>();
    for (const device of devices) {
      if (!unique.has(device.id)) {
        unique.set(device.id, device);
      }
    }
    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Fetch playlists for the given service/user combination.
   */
  public async getPlaylists(
    service: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistEntry[]> {
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return [];
    }
    return provider.getPlaylists(offset, limit);
  }

  /**
   * Fetch a folder tree for the given service/user.
   */
  public async getFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const cleanedId = this.sanitizeSpotifyId(folderId);
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return null;
    }
    return provider.getFolder(cleanedId, offset, limit);
  }

  /**
   * The artists a provider itself puts beside one of its own — when it can say.
   *
   * Optional on purpose: this is editorial data, and only a catalogue owner has it. A provider
   * without the notion answers nothing and the caller falls back to what it can derive, which is
   * how a feature can be per-service without every service having to grow it.
   */
  public async getRelatedArtists(
    service: string,
    user: string,
    folderId: string,
    limit: number,
  ): Promise<ContentFolderItem[]> {
    const provider = this.resolveProvider(service, user);
    if (!provider || typeof (provider as { getRelatedArtists?: unknown }).getRelatedArtists !== 'function') {
      return [];
    }
    const capable = provider as {
      getRelatedArtists(folderId: string, limit: number): Promise<ContentFolderItem[]>;
    };
    return await capable.getRelatedArtists(this.sanitizeSpotifyId(folderId), limit);
  }

  /**
   * Resolve a single track for the given service/user combination.
   */
  public async getTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null> {
    const cleanedId = this.sanitizeSpotifyId(trackId);
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return null;
    }
    return provider.getTrack(cleanedId);
  }

  /**
   * Perform a Spotify search with filters (e.g. "spotify@user:track#5,album#5").
   * Returns grouped results keyed by type (tracks, albums, artists, playlists).
   */
  public async search(
    source: string,
    query: string,
  ): Promise<{
    result: Record<string, ContentFolderItem[]> & { _totals?: Record<string, number> };
    user: string;
    providerId: string;
  }> {
    const [providerPart = '', filterPart = ''] = source.split(':');
    const { limits, maxLimit } = parseSearchLimits(filterPart);
    const [service = '', user = ''] = providerPart.split('@');
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return {
        result: {},
        user: user || 'nouser',
        providerId: this.normalizeServiceId(service),
      };
    }

    // Every provider answers the same call. This used to be seven `instanceof` branches
    // with identical bodies, plus Spotify's Web API mapping inline below them.
    const { result, user: providerUser, providerId } = await provider.search(query, limits, maxLimit);
    return { result, user: providerUser, providerId };
  }

  /**
   * Follow-state helpers used by the Loxone commands.
   */
  public async getFollowState(
    service: string,
    user: string,
    itemId: string,
  ): Promise<{ isfollowed: boolean; isowner: boolean }> {
    const provider = this.resolveProvider(service, user);
    if (!provider || !this.isRealSpotifyProvider(provider)) {
      if (provider) {
        this.log.debug('bridge provider skipped for spotify follow state', {
          provider: provider.providerId,
        });
      }
      return { isfollowed: false, isowner: false };
    }
    const parsed = this.parseSpotifyId(itemId);
    if (!parsed) {
      return { isfollowed: false, isowner: false };
    }
    const token = await provider.fetchAccessToken();
    if (!token) {
      return { isfollowed: false, isowner: false };
    }

    const { type, id } = parsed;
    try {
      if (type === 'playlist') {
        const me = provider.accountId;
        const contains = await this.fetchJson<boolean[]>(
          `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(id)}/followers/contains?ids=${encodeURIComponent(me)}`,
          token,
        );
        const playlist = await this.fetchJson<any>(
          `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(id)}`,
          token,
        );
        return {
          isfollowed: Array.isArray(contains) ? !!contains[0] : false,
          isowner: playlist?.owner?.id ? playlist.owner.id === me : false,
        };
      }

      if (type === 'artist' || type === 'show') {
        const resp = await this.fetchJson<boolean[]>(
          `${SPOTIFY_API_BASE}/me/following/contains?type=${type}&ids=${encodeURIComponent(id)}`,
          token,
        );
        return { isfollowed: Array.isArray(resp) ? !!resp[0] : false, isowner: false };
      }

      if (type === 'album') {
        const resp = await this.fetchJson<boolean[]>(
          `${SPOTIFY_API_BASE}/me/albums/contains?ids=${encodeURIComponent(id)}`,
          token,
        );
        return { isfollowed: Array.isArray(resp) ? !!resp[0] : false, isowner: false };
      }
    } catch {
      /* ignore */
    }
    return { isfollowed: false, isowner: false };
  }

  public async setFollowState(
    service: string,
    user: string,
    itemId: string,
    follow: boolean,
  ): Promise<void> {
    const provider = this.resolveProvider(service, user);
    if (!provider || !this.isRealSpotifyProvider(provider)) return;
    const parsed = this.parseSpotifyId(itemId);
    if (!parsed) return;
    const token = await provider.fetchAccessToken();
    if (!token) return;

    const { type, id } = parsed;
    const method = follow ? 'PUT' : 'DELETE';

    try {
      if (type === 'playlist') {
        await this.doRequest(
          `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(id)}/followers`,
          token,
          method,
          follow ? { public: false } : undefined,
        );
        return;
      }
      if (type === 'artist' || type === 'show') {
        await this.doRequest(
          `${SPOTIFY_API_BASE}/me/following?type=${type}&ids=${encodeURIComponent(id)}`,
          token,
          method,
        );
        return;
      }
      if (type === 'album') {
        await this.doRequest(
          `${SPOTIFY_API_BASE}/me/library`,
          token,
          method,
          { uris: [`spotify:album:${id}`] },
        );
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Exposes a Spotify access token for a given account (or the first available account).
   */
  public async getAccessTokenForAccount(accountId?: string, forceRefresh = false): Promise<string | null> {
    const provider = this.resolveProvider('spotify', accountId ?? '');
    if (!provider) {
      const fallback = this.accounts[0];
      if (!fallback) {
        return null;
      }
      const fallbackProvider = this.providers.get(this.providerIdFor(fallback.id));
      if (!this.isRealSpotifyProvider(fallbackProvider)) {
        if (fallbackProvider) {
          this.log.debug('bridge provider skipped for spotify access token', {
            provider: fallbackProvider.providerId,
          });
        }
        return null;
      }
      return fallbackProvider.fetchAccessToken(forceRefresh);
    }
    if (!this.isRealSpotifyProvider(provider)) {
      this.log.debug('bridge provider skipped for spotify access token', {
        provider: provider.providerId,
      });
      return null;
    }
    return provider.fetchAccessToken(forceRefresh);
  }

  /**
   * Returns the first configured Spotify account id (if any).
   */
  public getDefaultAccountId(): string | null {
    return this.accounts[0]?.id ?? null;
  }

  /**
   * Checks if a provider (real or bridge) exists for the given service id.
   */
  public hasProvider(service: string): boolean {
    if (!service) return false;
    const trimmed = service.trim();
    const candidates = [trimmed, this.normalizeServiceId(trimmed)];
    const withoutFilters = trimmed.split(':')[0] || '';
    if (withoutFilters && withoutFilters !== trimmed) {
      candidates.push(withoutFilters);
    }
    return candidates.some((id) => id && this.providers.has(id));
  }

  private resolveProvider(
    service: string,
    user: string,
  ): ContentProvider | null {
    const id = this.resolveProviderId(service, user);
    if (id) {
      return this.providers.get(id)!;
    }

    // No explicit match. With a single configured provider, defaulting to it is
    // safe and keeps nouser/empty-user commands working. With several providers,
    // returning an arbitrary one would leak another account's library (the old
    // "first provider" fallback), so refuse and let the caller serve empty.
    if (this.providers.size === 1) {
      return this.providers.values().next().value ?? null;
    }
    this.log.warn('no spotify provider matched request; refusing to guess', {
      service,
      user,
      providerCount: this.providers.size,
    });
    return null;
  }

  /**
   * Map a (service, user) request to a configured provider id.
   *
   * The Loxone client echoes back the advertised `user` label (the account's
   * displayName or a bridge label) — not our internal account id — so a direct
   * `spotify@<label>` lookup misses. Resolve the label back to the real account
   * or bridge id before giving up.
   *
   * Order matters, most specific first: an addressed account beats a bare service
   * name. The Loxone app has only one streaming service, so it asks for every one
   * of them as `spotify` and names the real one in `user` — resolving the bare
   * `spotify` first meant that as soon as one Spotify account existed, it answered
   * for Apple Music, SoundCloud and the rest. The same order also keeps a request
   * addressed to the second of two Spotify accounts off the first one.
   */
  private resolveProviderId(service: string, user: string): ProviderId | null {
    // A service-native request may hand the account over separately, as search
    // does (`applemusic` + `p0gngd`). With several accounts of one service the
    // service name alone would resolve to the first, so try the pair first.
    if (service && user) {
      const paired = this.normalizeServiceId(`${service}:${user}`);
      if (this.providers.has(paired)) {
        return paired;
      }
    }
    if (user) {
      const direct = this.providerIdFor(user);
      if (this.providers.has(direct)) {
        return direct;
      }
      const accountId = this.findAccountIdByUsername(user);
      if (accountId) {
        const accountProviderId = this.providerIdFor(accountId);
        if (this.providers.has(accountProviderId)) {
          return accountProviderId;
        }
      }
      const bridgeId = this.findBridgeIdByLabel(user);
      if (bridgeId) {
        const bridgeProviderId = this.providerIdFor(bridgeId);
        if (this.providers.has(bridgeProviderId)) {
          return bridgeProviderId;
        }
      }
    }
    // Nothing named an account. The service on its own is enough when it names a
    // provider outright (`applemusic`), or when the request simply carries no
    // account — which is where the sole/default Spotify account comes in.
    if (service) {
      const serviceId = this.normalizeServiceId(service);
      if (this.providers.has(serviceId)) {
        return serviceId;
      }
    }
    return null;
  }

  /**
   * Resolve a bridge id by matching its id or label (case-insensitive).
   */
  private findBridgeIdByLabel(value: string): string | null {
    if (!value) return null;
    const target = value.trim().toLowerCase();
    const match = (this.bridges ?? []).find((bridge) => {
      if (!bridge || bridge.enabled === false) {
        return false;
      }
      return [bridge.id, bridge.label]
        .filter(Boolean)
        .map((v) => v!.toString().trim().toLowerCase())
        .includes(target);
    });
    return match?.id ?? null;
  }

  private isRealSpotifyProvider(
    provider: ContentProvider | null | undefined,
  ): provider is SpotifyAccountProvider {
    if (!provider || !(provider instanceof SpotifyAccountProvider)) {
      return false;
    }
    const account = provider.getServiceAccount?.();
    if (account?.fake) {
      return false;
    }
    if (account?.provider && account.provider !== 'spotify') {
      return false;
    }
    return true;
  }

  private normalizeServiceId(service: string): ProviderId {
    if (!service) {
      return '';
    }
    const trimmed = service.trim();
    if (trimmed.toLowerCase().startsWith('spotify@')) {
      return trimmed;
    }
    // Service-native form: a real service name (`applemusic`) or `service:slug`.
    // Resolve it to the internal bridge provider-map key (spotify@<bridgeId>).
    const bridgeProviderId = this.bridgeProviderIdForServiceNative(trimmed);
    if (bridgeProviderId) {
      return bridgeProviderId;
    }
    const accountProviderId = this.accountProviderIdForServiceNative(trimmed);
    if (accountProviderId) {
      return accountProviderId;
    }
    return this.providerIdFor(trimmed);
  }

  /**
   * Map Spotify's own service-native identity — `spotify`, or `spotify:<accountId>` when there
   * are several accounts — to the internal provider-map key `spotify@<accountId>`.
   *
   * The bridge services above are named after their provider, so a bare `applemusic` resolves;
   * Spotify's accounts are keyed by account id, so a bare `spotify` matched nothing and every
   * caller that has only the service name got "no provider matched; refusing to guess". That
   * hit the public browse API's container lookup on every Spotify folder, which passes the
   * service without an account because a browse ref carries no account.
   */
  private accountProviderIdForServiceNative(serviceNative: string): ProviderId | null {
    const raw = serviceNative.trim().toLowerCase();
    if (raw !== 'spotify' && !raw.startsWith('spotify:')) {
      return null;
    }
    const accountIds = this.accounts
      .map((acc) => (acc.id || acc.user || '').trim())
      .filter(Boolean);
    if (accountIds.length === 0) {
      return null;
    }
    // `spotify:<slug>` — but the same grammar also carries search filters
    // (`spotify:track#20`), so this only ever matches a real account id and otherwise
    // falls through to the unnamed case below.
    const slug = raw.slice('spotify:'.length);
    if (slug) {
      const match = accountIds.find((id) => id.toLowerCase() === slug);
      return match ? this.providerIdFor(match) : null;
    }
    // Unnamed. With one account there is nothing to disambiguate; with several, the bare
    // name is genuinely ambiguous and this answers with the same default account the rest
    // of the server already uses for an unaddressed request. The service key for a
    // multi-account setup spells the account out, so that case is not reached by our own
    // consumers — only by something that dropped the account on the way.
    if (accountIds.length === 1) {
      return this.providerIdFor(accountIds[0]!);
    }
    const preferred = this.getDefaultAccountId();
    return preferred ? this.providerIdFor(preferred) : null;
  }

  /**
   * Map a service-native identity — a bare service name (`applemusic`, sole
   * account) or `service:slug` (multi-account) — to the internal bridge
   * provider-map key `spotify@<bridgeId>`. Returns null when it is not a
   * configured bridge service (e.g. real Spotify).
   */
  private bridgeProviderIdForServiceNative(serviceNative: string): ProviderId | null {
    const raw = serviceNative.trim().toLowerCase();
    if (!raw || raw === 'spotify') {
      return null;
    }
    // Either separator names the account: browse ids spend the colon (`applemusic:p0gngd`),
    // search sources spend it on the filter list and use `@` instead.
    const [service, slug] = raw.split(/[:@]/);
    const candidates = (this.bridges ?? []).filter(
      (b) => b && b.enabled !== false && (b.provider || '').toLowerCase() === service,
    );
    if (candidates.length === 0) {
      return null;
    }
    const match = slug
      ? candidates.find((b) => slugFromBridgeId(b.id, service!).toLowerCase() === slug)
      : candidates[0];
    return match ? this.providerIdFor(match.id) : null;
  }

  /**
   * Check if an account id exists in the configured accounts.
   */
  public hasAccount(accountId: string | null | undefined): boolean {
    if (!accountId) {
      return false;
    }
    const normalized = accountId.trim().toLowerCase();
    return this.accounts.some((acc) => acc.id?.trim().toLowerCase() === normalized);
  }

  /**
    * Resolve an account id by matching username/email/displayName (case-insensitive).
    */
  public findAccountIdByUsername(username: string): string | null {
    if (!username) return null;
    const target = username.trim().toLowerCase();
    const match = this.accounts.find((acc) => {
      const candidates = [
        acc.id,
        acc.user,
        acc.email,
        acc.spotifyId,
        acc.displayName,
        acc.name,
      ]
        .filter(Boolean)
        .map((v) => v!.toString().trim().toLowerCase());
      return candidates.includes(target);
    });
    return match?.id ?? null;
  }

  private providerIdFor(accountId: string | undefined): ProviderId {
    const id = accountId && accountId.trim() ? accountId.trim() : 'nouser';
    return `spotify@${id}`;
  }

  private bridgeProviderId(bridge: StreamingServiceConfig): ProviderId {
    return this.providerIdFor(bridge.id);
  }

  /**
   * The SERVICE-NATIVE audiopath prefix a bridge provider should emit, e.g.
   * `applemusic` (single account) or `applemusic:p0gngd` (multiple accounts of
   * that service). This is the core identity — the internal provider-map key
   * stays `spotify@<bridgeId>` (see bridgeProviderId). The Loxone adapter
   * translates between the two at the protocol boundary.
   *
   * The same identity names an account to every non-Loxone consumer, so the rule
   * itself lives in `domain/media/serviceIdentity`.
   */
  private serviceNativePrefixFor(bridge: StreamingServiceConfig): string {
    return serviceNativeKey(bridge, this.bridges);
  }

  private registerBridgeProviders(): void {
    if (!Array.isArray(this.bridges) || this.bridges.length === 0) return;

    for (const bridge of this.bridges) {
      if (!bridge || bridge.enabled === false) continue;
      const providerId = this.bridgeProviderId(bridge);
      // Internal provider-map key stays `spotify@<bridgeId>` (providerId); the
      // service-native prefix is what the provider emits into audiopaths.
      const serviceNativePrefix = this.serviceNativePrefixFor(bridge);
      const providerType = (bridge.provider || 'spotify').toLowerCase();
      const labelOverride = bridge.label || bridge.id;
      if (this.providers.has(providerId)) {
        this.log.warn('bridge provider skipped; provider id already registered', { providerId });
        continue;
      }

      const definition = providerDefinition(providerType);
      if (definition) {
        this.providers.set(
          providerId,
          definition.create({
            providerId,
            serviceNativePrefix,
            label: labelOverride,
            bridge,
            coverHost: resolveCoverHost(this.configPort.getConfig()?.system?.audioserver?.ip),
            coverOrigin: {
              protocol: this.configPort.getConfig()?.system?.audioserver?.artworkProtocol,
              port: this.configPort.getConfig()?.system?.audioserver?.artworkPort,
            },
          }),
        );
        continue;
      }

      // Nothing implements this provider id. The account it was configured against still
      // answers, under that name — the original way a non-Spotify service was offered here.
      const account = this.resolveBridgeSourceAccount(bridge);
      if (!account) continue;
      const provider = new FakeSpotifyAccountProvider(providerType, labelOverride, {
        providerId,
        serviceNativePrefix,
        account,
        clientId: account.clientId ?? this.clientId,
        persistAccount: this.persistAccountState,
      });
      this.providers.set(providerId, provider);
    }
  }

  private resolveBridgeSourceAccount(bridge: StreamingServiceConfig): SpotifyAccountState | null {
    if (!this.accounts.length) {
      this.log.warn('bridge provider skipped; no spotify accounts configured', { bridge: bridge.id });
      return null;
    }
    if (bridge.accountId) {
      const match = this.accounts.find(
        (acc) => acc.id?.trim().toLowerCase() === bridge.accountId?.trim().toLowerCase(),
      );
      if (match) return match;
      this.log.warn('bridge provider account not found; falling back to first account', {
        bridge: bridge.id,
        accountId: bridge.accountId,
      });
    }
    return this.accounts[0] ?? null;
  }

  private sanitizeSpotifyId(value: string): string {
    if (!value) return '';
    let cleaned = value.trim();
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      /* ignore */
    }
    return cleaned.replace(/\]+$/, '').replace(/\/+$/, '');
  }

  private parseSpotifyId(itemId: string): { type: 'track' | 'album' | 'artist' | 'playlist' | 'show'; id: string } | null {
    const cleaned = this.sanitizeSpotifyId(itemId);
    if (!cleaned) {
      return null;
    }
    const match = cleaned.match(/spotify@[^:]+:(track|album|artist|playlist|show|episode):(.+)/i);
    if (match) {
      const type = (match[1] ?? '').toLowerCase();
      const id = match[2] ?? '';
      if (type === 'episode') {
        return { type: 'show', id }; // episodes follow show subscriptions
      }
      return { type: type as 'track' | 'album' | 'artist' | 'playlist' | 'show', id };
    }
    const plain = cleaned.match(/^(track|album|artist|playlist|show):(.+)/i);
    if (plain) {
      const type = (plain[1] ?? '').toLowerCase();
      const id = plain[2] ?? '';
      if (type === 'episode') {
        return { type: 'show', id };
      }
      return { type: type as 'track' | 'album' | 'artist' | 'playlist' | 'show', id };
    }
    return null;
  }

  private async doRequest(
    url: string,
    token: string,
    method: 'GET' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    await fetch(url, init);
  }

  private async fetchJson<T>(url: string, token: string): Promise<T | null> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  private displayLabel(acc: SpotifyAccountState): string {
    return (
      acc.displayName ||
      acc.name ||
      acc.user ||
      acc.email ||
      acc.id
    );
  }

  /**
   * Persist refresh-token updates to the stored config.
   */
  private readonly persistAccountState: PersistAccountCallback = async (
    accountId,
    patch,
  ) => {
    let updated: SpotifyAccountConfig | null = null;

    await this.configPort.updateConfig((cfg) => {
      const accounts = cfg.content.spotify.accounts || [];
      const idx = accounts.findIndex(
        (acc) =>
          (acc.id && acc.id === accountId) ||
          (acc.user && acc.user === accountId) ||
          (acc.email && acc.email === accountId),
      );

      if (idx >= 0) {
        accounts[idx] = { ...accounts[idx], ...patch };
        updated = accounts[idx];
      } else {
        const acc: SpotifyAccountConfig = { id: accountId, ...patch };
        accounts.push(acc);
        updated = acc;
      }

      cfg.content.spotify.accounts = accounts;
    });

    // also update in-memory copy for existing provider
    const providerId = this.providerIdFor(accountId);
    const provider = this.providers.get(providerId);
    if (provider && updated && provider instanceof SpotifyAccountProvider) {
      provider.updateAccount(updated);
    }

    return updated;
  };
}

function normalizeSpotifyConfig(
  spotifyCfg: { accounts?: SpotifyAccountConfig[]; clientId?: string; bridges?: StreamingServiceConfig[] } | undefined,
): { accounts: SpotifyAccountConfig[]; clientId?: string; bridges: StreamingServiceConfig[] } {
  const cfg = spotifyCfg ?? { accounts: [], bridges: [] };
  return {
    accounts: cfg.accounts ?? [],
    clientId: cfg.clientId,
    bridges: cfg.bridges ?? [],
  };
}

function loadSpotifyConfig(
  configPort: ConfigPort,
): { accounts: SpotifyAccountConfig[]; clientId?: string; bridges: StreamingServiceConfig[] } {
  try {
    const cfg = configPort.getConfig();
    const normalized = normalizeSpotifyConfig(cfg.content?.spotify);
    // Non-Spotify accounts live in the neutral content.streamingServices; the
    // manager still refers to them as "bridges" internally (Loxone concept).
    normalized.bridges = cfg.content?.streamingServices ?? normalized.bridges;
    return normalized;
  } catch {
    return { accounts: [], bridges: [] };
  }
}

export function buildSpotifyManagerFromConfig(configPort: ConfigPort): SpotifyServiceManager {
  const cfg = loadSpotifyConfig(configPort);
  return new SpotifyServiceManager(configPort, cfg.accounts, cfg.clientId, cfg.bridges);
}

/**
 * Keeps a shared Spotify manager instance bound to a specific ConfigPort.
 */
export class SpotifyServiceManagerProvider {
  private manager: SpotifyServiceManager | null = null;
  // Spelled out rather than a constructor parameter property: the test runner
  // strips types without transforming, and that syntax needs a transform.
  private readonly configPort: ConfigPort;

  constructor(configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public get(): SpotifyServiceManager {
    if (!this.manager) {
      this.manager = buildSpotifyManagerFromConfig(this.configPort);
    }
    return this.manager;
  }

  public reload(): SpotifyServiceManager {
    const cfg = loadSpotifyConfig(this.configPort);
    if (this.manager) {
      this.manager.reload(cfg.accounts ?? [], cfg.clientId, cfg.bridges ?? []);
      return this.manager;
    }
    this.manager = new SpotifyServiceManager(this.configPort, cfg.accounts ?? [], cfg.clientId, cfg.bridges ?? []);
    return this.manager;
  }
}
