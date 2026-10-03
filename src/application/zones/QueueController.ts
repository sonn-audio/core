import type { ComponentLogger } from '@/shared/logging/logger';
import type { ContentFolderItem } from '@/ports/ContentTypes';
import type { ContentPort } from '@/ports/ContentPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import { decodeAudiopath, detectServiceFromAudiopath, parseServiceNativeAudiopath, BRIDGE_STREAMING_SERVICES, BRIDGE_QUEUE_SERVICES } from '@/domain/zones/audiopath';
import { toServiceNative } from '@/domain/zones/bridgeIdentity';
import {
  createQueueItem,
  mapFolderItemsToQueue,
  normalizeSpotifyAudiopath,
  parseSpotifyUser,
} from '@/application/zones/helpers/queueHelpers';
import {
  clamp,
  fallbackTitle,
  resolveDisplayAudiotype,
  sanitizeTitle,
} from '@/application/zones/helpers/stateHelpers';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { QueueAuthority, QueueItem, ZoneContext } from '@/application/zones/internal/zoneTypes';
import { ZoneRepository } from '@/application/zones/ZoneRepository';

type QueueControllerDeps = {
  log: ComponentLogger;
  contentPort: ContentPort;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  isRadioAudiopath: (audiopath: string | undefined, audiotype?: number | null) => boolean;
  isSpotifyAudiopath: (audiopath: string | null | undefined) => boolean;
  isMusicAssistantAudiopath: (audiopath: string | null | undefined) => boolean;
  providerForAudiopath: (audiopath: string | null | undefined) => string | null;
  resolveBridgeProvider: (rawAudiopath: string | undefined | null) => string | null;
  getMusicAssistantUserId: () => string;
  getStateAudiotype: (ctx: ZoneContext, item?: QueueItem | null) => number | null;
  getStateFileType: () => number;
  resolveSourceName: (
    audiotype: number | null | undefined,
    ctx: ZoneContext,
    current?: QueueItem | null,
  ) => string | undefined;
  notifier: NotifierPort;
};

export class QueueController {
  private readonly log: ComponentLogger;
  private readonly contentPort: ContentPort;

  constructor(
    private readonly zoneRepo: ZoneRepository,
    private readonly deps: QueueControllerDeps,
  ) {
    this.log = deps.log;
    this.contentPort = deps.contentPort;
  }

  public getQueue(zoneId: number, start: number, limit: number) {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return {
        id: zoneId,
        items: [],
        shuffle: false,
        start: 0,
        totalitems: 0,
        authority: 'local' as QueueAuthority,
      };
    }

    if (this.deps.isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
      return {
        id: zoneId,
        items: [],
        shuffle: ctx.queue.shuffle,
        start: 0,
        totalitems: 0,
        authority: ctx.queue.authority,
      };
    }

    if (ctx.queue.shuffle && !ctx.metadata.queueShuffled) {
      this.reorderQueue(ctx, 'shuffle', { keepCurrent: true, shuffleUpcoming: true });
    }

    const slice = ctx.queue.items.slice(start, start + limit).map((item) => {
      const { originalIndex: _originalIndex, ...rest } = item;
      return {
        ...rest,
        // Loxone kan geen spotify@username prefixes aan; strip alleen voor output.
        audiopath: sanitizeAudiopathForOutput(item.audiopath),
        // Mask station for local/library items so they don't show as radio entries.
        station: (item.audiopath ?? '').startsWith('library:') ? '' : item.station ?? '',
      };
    });
    this.log.debug('getQueue', {
      zoneId,
      start,
      limit,
      total: ctx.queue.items.length,
      returned: slice.length,
    });
    return {
      id: zoneId,
      items: slice,
      shuffle: ctx.queue.shuffle,
      start,
      totalitems: ctx.queue.items.length,
      authority: ctx.queue.authority,
    };
  }

  /**
   * The queue as stored, without the Loxone-facing rewrites `getQueue` applies.
   *
   * `getQueue` collapses every service-native audiopath to `spotify:<kind>:<id>`
   * because the native client's queue schema is fail-hard about that prefix. Any
   * consumer that is not that client needs the real ids, so it reads this instead.
   */
  public getRawQueue(
    zoneId: number,
    start: number,
    limit: number,
  ): { items: QueueItem[]; start: number; total: number; currentIndex: number | null } {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return { items: [], start: 0, total: 0, currentIndex: null };
    }
    const all = ctx.queue.items;
    const from = Math.max(0, start);
    return {
      items: all.slice(from, from + Math.max(0, limit)),
      start: from,
      total: all.length,
      currentIndex: ctx.queueController.currentIndex(),
    };
  }

  public isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    // Provider-backed queues (Apple Music/Deezer/Tidal) are still driven by the local queue controller.
    // Treat them as "local" so auto-advance and next/prev keep working even if an output snapshot
    // reports a provider-flavored authority.
    return (
      !authority ||
      authority === 'local' ||
      authority === 'applemusic' ||
      authority === 'deezer' ||
      authority === 'tidal' ||
      authority === 'amazonmusic' ||
      authority === 'ytmusic' ||
      authority === 'soundcloud'
    );
  }

  public seekInQueue(zoneId: number, target: string): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    return this.seekExistingQueueInternal(ctx, target);
  }

  public setShuffle(zoneId: number, enabled: boolean): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const wasEnabled = ctx.queue.shuffle;
    ctx.queue.shuffle = enabled;
    this.deps.applyPatch(zoneId, { plshuffle: enabled ? 1 : 0 });
    if (enabled === wasEnabled) {
      if (enabled && !ctx.metadata.queueShuffled) {
        this.reorderQueue(ctx, 'shuffle', { keepCurrent: true, shuffleUpcoming: true });
      } else if (!enabled && ctx.metadata.queueShuffled) {
        this.reorderQueue(ctx, 'unshuffle', { keepCurrent: true, shuffleUpcoming: true });
      }
      return;
    }
    this.reorderQueue(ctx, enabled ? 'shuffle' : 'unshuffle', {
      keepCurrent: true,
      shuffleUpcoming: true,
    });
  }

  public setPendingShuffle(zoneId: number, enabled: boolean): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    ctx.metadata.pendingShuffle = enabled;
  }

  public setRepeatMode(zoneId: number, mode: 'off' | 'one' | 'all'): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const repeat = mode === 'one' ? 3 : mode === 'all' ? 1 : 0;
    ctx.queue.repeat = repeat;
    this.deps.applyPatch(zoneId, { plrepeat: repeat });
  }

  public updateQueueFromOutput(zoneId: number, items: QueueItem[], currentIndex: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || !Array.isArray(items)) {
      return;
    }
    if (ctx.alert) {
      return;
    }
    if (items.length === 0) {
      // Ignore empty snapshots from outputs so we don't wipe the local queue on transient polls.
      return;
    }
    const existingItems = ctx.queue.items ?? [];

    // Reject queue updates whose audiopaths relate to neither the currently playing
    // track nor the existing queue. This stops a stale Spotify Connect / Music Assistant
    // poll from clobbering the live state while another source (e.g. radio) is playing.
    const stateAudiopath = ctx.state.audiopath ?? '';
    const stateNorm = normalizeSpotifyAudiopath(stateAudiopath);
    const incomingNorms = items
      .map((item) => normalizeSpotifyAudiopath(item.audiopath ?? ''))
      .filter((value): value is string => Boolean(value));
    if (stateAudiopath && stateNorm && incomingNorms.length > 0) {
      const overlapsCurrent = incomingNorms.includes(stateNorm);
      const overlapsExistingQueue = existingItems.some((item) =>
        incomingNorms.includes(normalizeSpotifyAudiopath(item.audiopath ?? '')),
      );
      if (!overlapsCurrent && !overlapsExistingQueue) {
        this.log.debug('queue update rejected; foreign audiopath while another source plays', {
          zoneId,
          stateAudiopath,
          incoming: incomingNorms[0],
        });
        return;
      }
    }

    let applyItems = items;
    let applyIndex = currentIndex;

    // If the output only returns the current item, merge it into the existing queue
    // instead of wiping the full queue that the user built.
    if (items.length === 1 && existingItems.length > 1) {
      const targetIndex = Math.max(
        0,
        Math.min(
          typeof currentIndex === 'number' ? currentIndex : ctx.queueController.currentIndex(),
          existingItems.length - 1,
        ),
      );
      applyItems = existingItems.map((existing, idx) =>
        idx === targetIndex ? { ...existing, ...items[0], qindex: idx } : { ...existing, qindex: idx },
      );
      applyIndex = targetIndex;
      this.log.debug('queue update merged single output item into existing queue', {
        zoneId,
        targetIndex,
        existing: existingItems.length,
      });
    }

    // Skip queue update if nothing changed (same items and index).
    const buildSignature = (list: QueueItem[]): string =>
      `${list.length}:${list
        .map((item) => normalizeSpotifyAudiopath(item.audiopath ?? '') || '')
        .join('|')}`;
    const newSignature = buildSignature(applyItems);
    const prevSignature = ctx.metadata.lastQueueSignature as string | undefined;
    const prevIndex = ctx.queueController.currentIndex();
    const targetIndex =
      typeof applyIndex === 'number' && applyItems.length
        ? Math.max(0, Math.min(applyIndex, applyItems.length - 1))
        : prevIndex;
    const signatureUnchanged = newSignature === prevSignature && targetIndex === prevIndex;

    const current = signatureUnchanged
      ? ctx.queueController.current()
      : ctx.queueController.updateFromOutput(applyItems, targetIndex);
    if (!current) {
      return;
    }
    const authority = this.resolveQueueAuthorityFromItems(applyItems);
    // Only let Squeezelite-reported items update authority when a zone input
    // is active. If activeInput is null the zone is idle/stopped and we must
    // not revert the authority that stopPlayback already reset to 'local'.
    if (authority && ctx.activeInput) {
      ctx.queue.authority = authority;
    }
    if (!signatureUnchanged) {
      ctx.metadata.lastQueueSignature = newSignature;
      ctx.metadata.lastQueueIndex = ctx.queueController.currentIndex();
      this.log.debug('queue updated from output', {
        zoneId: ctx.id,
        items: items.length,
        currentIndex: ctx.queueController.currentIndex(),
        authority: ctx.queue.authority,
      });
    }
    // Only trust item duration when a zone input is active. In stopped/idle
    // state the item still carries its last-known duration (e.g. 156 s from
    // the last Spotify track) which would re-show the progress bar after
    // stopPlayback already cleared it.
    const duration =
      ctx.activeInput && typeof current.duration === 'number' && current.duration > 0
        ? current.duration
        : typeof ctx.state.duration === 'number'
          ? ctx.state.duration
          : 0;
    const fallback = fallbackTitle(ctx.state.title, ctx.name);
    const nextTitle = sanitizeTitle(current.title, fallback);
    const useTitle =
      nextTitle !== (ctx.state.title ?? '') || (current.title && !nextTitle.startsWith(ctx.name));
    const stateAudiotype = this.deps.getStateAudiotype(ctx, current);
    const displayAudiotype = stateAudiotype ?? current.audiotype;
    const sourceName = this.deps.resolveSourceName(displayAudiotype, ctx, current);
    const keepExistingExternalAudiotype =
      displayAudiotype === 0 &&
      typeof ctx.state.audiotype === 'number' &&
      ctx.state.audiotype > 0 &&
      typeof current.audiopath === 'string' &&
      current.audiopath.trim().length === 0;
    const keepExistingExternalSourceName =
      sourceName === ctx.sourceMac &&
      typeof ctx.state.sourceName === 'string' &&
      ctx.state.sourceName.trim().length > 0 &&
      ctx.state.sourceName !== ctx.sourceMac;
    // When the incoming item refreshes the currently-playing audiopath, only
    // overwrite metadata fields that carry a non-empty value. Otherwise a
    // periodic poll from an output without per-track metadata (e.g. raw HTTP
    // radio reported by squeezelite, or a Spotify status snapshot) would wipe
    // the live ICY/track metadata we already have.
    const isRefreshOfCurrent =
      Boolean(stateNorm) &&
      normalizeSpotifyAudiopath(current.audiopath ?? '') === stateNorm;
    const metadataPatch = isRefreshOfCurrent
      ? {
          ...(current.artist ? { artist: current.artist } : {}),
          ...(current.album ? { album: current.album } : {}),
          ...(current.coverurl ? { coverurl: current.coverurl } : {}),
          ...(current.station ? { station: current.station } : {}),
        }
      : {
          artist: current.artist,
          album: current.album,
          coverurl: current.coverurl,
          station: current.station,
        };
    this.deps.applyPatch(zoneId, {
      ...(useTitle ? { title: nextTitle } : {}),
      ...metadataPatch,
      audiopath: current.audiopath,
      qindex: ctx.queueController.currentIndex(),
      qid: current.unique_id,
      type: this.deps.getStateFileType(),
      ...(!keepExistingExternalAudiotype && displayAudiotype != null
        ? { audiotype: resolveDisplayAudiotype(displayAudiotype, ctx.queue.authority) }
        : {}),
      duration: duration > 0 ? duration : undefined,
      queueAuthority: ctx.queue.authority,
      ...(!keepExistingExternalSourceName && sourceName ? { sourceName } : {}),
    });
    // Only resolve duration when a zone input is active. After stopPlayback the
    // zone becomes idle (activeInput = null) and we must not let an async Spotify
    // API response re-apply the last track's duration over the reset value of 0.
    if (duration <= 0 && ctx.activeInput) {
      void this.resolveTrackDuration(current.audiopath).then((dur) => {
        if (dur > 0) {
          this.deps.applyPatch(zoneId, { duration: dur });
        }
      });
    }
    if (!this.deps.isRadioAudiopath(current.audiopath, current.audiotype)) {
      this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    }
  }

  /**
   * Flattens container items (e.g. the albums returned when browsing a library
   * artist) down to their tracks by browsing each one level deep, so an
   * artist/album favourite plays through like a playlist. Items that are already
   * tracks pass through untouched. Bounded to avoid unbounded fan-out, and falls
   * back to the original items if nothing flattens (preserves prior behaviour).
   */
  private async flattenContainersToTracks(
    items: ContentFolderItem[],
    providerId: string,
    user: string,
    service: string,
    maxItems?: number,
  ): Promise<ContentFolderItem[]> {
    const cap = maxItems && maxItems > 0 ? maxItems : 500;
    const tracks: ContentFolderItem[] = [];
    let expandedAny = false;
    for (const item of items) {
      if (tracks.length >= cap) {
        break;
      }
      const audiopath = item.audiopath ?? '';
      if (isPlayableTrackAudiopath(audiopath)) {
        tracks.push(item);
        continue;
      }
      const subFolderId = stripProviderPrefix(audiopath, service);
      if (!subFolderId) {
        continue;
      }
      try {
        const sub = await this.contentPort.getServiceFolder(providerId, user, subFolderId, 0, 200);
        for (const child of sub?.items ?? []) {
          if (tracks.length >= cap) {
            break;
          }
          if (isPlayableTrackAudiopath(child.audiopath ?? '')) {
            tracks.push(child);
            expandedAny = true;
          }
        }
      } catch (error) {
        this.log.debug('container flatten sub-browse failed', {
          providerId,
          subFolderId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // If nothing was expanded (all items were already tracks, or no container
    // yielded tracks), keep the original list so behaviour is never worse.
    return expandedAny ? tracks : items;
  }

  /**
   * Page through a service folder and collect its items.
   *
   * Stops at the caller's cap, at a short page, or at a hard 1000-item ceiling
   * that keeps "play my whole library" from pulling everything into one queue.
   */
  private async collectServiceFolderItems(
    providerId: string,
    user: string,
    folderId: string,
    maxItems?: number,
  ): Promise<ContentFolderItem[]> {
    const allItems: ContentFolderItem[] = [];
    const pageSize = 50;
    let offset = 0;
    let total = Number.MAX_SAFE_INTEGER;
    while (offset < total) {
      const folder = await this.contentPort.getServiceFolder(providerId, user, folderId, offset, pageSize);
      const items = folder?.items ?? [];
      if (items.length === 0) {
        break;
      }
      allItems.push(...items);
      total = Number.isFinite(folder?.totalitems) ? folder!.totalitems : Number.MAX_SAFE_INTEGER;
      offset += items.length;
      if (items.length < pageSize) {
        break;
      }
      if (maxItems && allItems.length >= maxItems) {
        break;
      }
      if (allItems.length >= 1000) {
        break;
      }
    }
    return allItems;
  }

  /**
   * Queue items for one bridged streaming service, or null when it has nothing
   * for this audiopath and the caller should try the next candidate.
   *
   * Apple Music, Deezer, Tidal, YouTube Music and SoundCloud are reached through
   * the identical pair of content-port calls, so they share one implementation.
   * They used to have a branch each, copied from the Apple one — and the copies
   * drifted: only Apple flattened containers, so playing a Deezer/Tidal/YTM/
   * SoundCloud *artist* queued the albums its listing returns and every one of
   * them was rejected downstream, where the stream services accept nothing but a
   * track. One implementation is what stops that from happening again.
   */
  private async buildBridgeQueueItems(args: {
    service: string;
    rawClean: string;
    sourcePath: string;
    zoneName: string;
    station?: string;
    maxItems?: number;
    defaultSpotifyUserId?: string | null;
  }): Promise<QueueItem[] | null> {
    const { service, rawClean, sourcePath, zoneName, station, maxItems, defaultSpotifyUserId } = args;
    const providerId = rawClean.split(':')[0] || service;
    const user = providerId.split('@')[1] ?? service;
    const folderId = stripProviderPrefix(sourcePath, service);

    // A track audiopath resolves straight to its item. `library-track` is
    // accepted for every service, not just Apple: the kind is a domain concept
    // (see KNOWN_KINDS in audiopath.ts) and the id keeps whichever form it came
    // in as, so the provider sees exactly what it was asked for.
    if (/^(library-)?track:/i.test(folderId)) {
      const kind = folderId.split(':')[0] ?? 'track';
      const trackId = folderId.split(':').slice(1).join(':');
      const track = await this.contentPort.getServiceTrack(providerId, user, `${kind}:${trackId}`);
      if (track) {
        return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
      }
      this.log.debug('bridge queue track lookup failed', {
        service,
        providerId,
        folderId,
        trackId,
      });
    }

    const allItems = await this.collectServiceFolderItems(providerId, user, folderId, maxItems);
    if (!allItems.length) {
      return null;
    }
    // Browsing an artist returns albums, not tracks; flatten any container items
    // down to their tracks so the favourite plays through like a playlist.
    const playable = await this.flattenContainersToTracks(allItems, providerId, user, service, maxItems);
    const trimmed = maxItems ? playable.slice(0, maxItems) : playable;
    return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? rawClean, defaultSpotifyUserId);
  }

  public async buildQueueForUri(
    uri: string,
    zoneName: string,
    station?: string,
    rawAudiopath?: string,
    options?: { maxItems?: number },
  ): Promise<QueueItem[]> {
    const stripRoutingSuffixLocal = (value: string): string =>
      value
        .replace(/\/parentid\/.*$/i, '')
        .replace(/\/parentpath\/.*$/i, '')
        .replace(/\/noshuffle.*$/i, '')
        .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
        .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
        .replace(/\/+$/, '');
    const rawPath = rawAudiopath ?? uri;
    const rawLower = (rawPath || '').toLowerCase();
    const bridgeProvider = this.deps.resolveBridgeProvider(rawPath);
    const forceSpotify = rawLower.startsWith('spotify@') && !bridgeProvider;
    const rawClean = stripRoutingSuffixLocal(rawPath);
    // When `uri` (the resolved target, e.g. a playlist URI) is itself a Spotify URI, prefer it
    // over `rawClean` from the raw audiopath. rawClean strips routing suffixes like /parentpath/
    // which can reduce a "track/parentpath/playlist" raw path to just the track URI — causing the
    // queue builder to fetch a single track instead of the intended playlist.
    const uriIsSpotify = uri.startsWith('spotify@') || uri.startsWith('spotify:');
    const decoded = (forceSpotify && !uriIsSpotify) ? rawClean : decodeAudiopath(uri);
    if (!decoded) {
      return [];
    }
    const maxItems = typeof options?.maxItems === 'number' && options.maxItems > 0 ? options.maxItems : undefined;
    const pickSourcePath = (): string => {
      if (station && station.trim()) {
        return station.trim();
      }
      const candidate = (decoded || rawAudiopath || uri || '').trim();
      if (candidate.includes(':')) {
        return candidate;
      }
      if (rawClean && rawClean.includes(':')) {
        return rawClean;
      }
      return candidate;
    };
    const isMusicAssistant = bridgeProvider === 'musicassistant' || (!forceSpotify && this.deps.isMusicAssistantAudiopath(rawPath));
    const service =
      bridgeProvider ||
      (forceSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : detectServiceFromAudiopath(rawPath));
    const defaultSpotifyUserId = this.contentPort.getDefaultSpotifyAccountId();

    // Local library content. Guard against bridge-routed content whose inner
    // (decoded) URI happens to use the `library:` scheme — Music Assistant's
    // native item URIs literally look like `library://album/713`, so without
    // this guard MA/bridge plays get swallowed here instead of falling through
    // to their proper bridge branch below.
    if (!forceSpotify && !bridgeProvider && !isMusicAssistant && (decoded.startsWith('library:') || decoded.startsWith('library-'))) {
      const folder = await this.contentPort.getMediaFolder(decoded, 0, 500);
      if (folder?.items?.length) {
        // local library items are not radio; do not propagate station
        const trimmed = maxItems ? folder.items.slice(0, maxItems) : folder.items;
        return mapFolderItemsToQueue(trimmed, zoneName, 0, 'nouser', '', defaultSpotifyUserId);
      }
      const meta = await this.contentPort.resolveMetadata(decoded);
      if (meta) {
        return [createQueueItem(uri, zoneName, meta, 0, defaultSpotifyUserId)];
      }
      return [];
    }

    // Music Assistant bridge content
    if (!forceSpotify && (isMusicAssistant || service === 'musicassistant' || /musicassistant/i.test(rawPath))) {
      const user = this.deps.getMusicAssistantUserId();
      // MA's folder resolver decodes the b64 payload itself and keys off the
      // `:<type>:` segment, so it needs the prefixed Loxone audiopath
      // (`spotify@bridge-…:album:b64_…`) — NOT a decoded bare MA URI like
      // `library://album/713`, which it mis-parses (713 → "recommendation"
      // instead of album 713). Prefer the resolved target (honours
      // parentContext, e.g. play-track-within-playlist), else the raw path;
      // pick whichever is still in prefixed form, falling back to pickSourcePath.
      const sourcePath =
        [uri, rawClean].find((p) => p && p.includes(':') && !p.includes('://')) ?? pickSourcePath();
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^musicassistant@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^musicassistant:/i, '');
      if (folderId.toLowerCase().startsWith('track:')) {
        const trackId = folderId.split(':').pop() ?? '';
        const track = await this.contentPort.getServiceTrack('musicassistant', user, trackId);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
      }
      const allItems = await this.collectServiceFolderItems('musicassistant', user, folderId, maxItems);
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? rawClean, defaultSpotifyUserId);
      }
    }

    // Bridge content for the streaming services that are all browsed through the
    // same two content-port calls. Consulted in the order they are listed, and a
    // service that matches but yields nothing falls through to the next and then
    // to Spotify below — which is what the five separate `if` blocks this
    // replaces did. `youtube` is a bridge service too (see
    // BRIDGE_STREAMING_SERVICES) but never had a branch here, so it keeps
    // falling through to Spotify; giving it one is a behaviour change, not a
    // cleanup, and belongs in its own commit.
    if (!forceSpotify) {
      for (const bridgeService of BRIDGE_QUEUE_SERVICES) {
        if (service !== bridgeService && !new RegExp(bridgeService, 'i').test(rawPath)) {
          continue;
        }
        const items = await this.buildBridgeQueueItems({
          service: bridgeService,
          rawClean,
          sourcePath: pickSourcePath(),
          zoneName,
          station,
          maxItems,
          defaultSpotifyUserId,
        });
        if (items) {
          return items;
        }
      }
    }

    // Spotify content
    const spotifyCandidate =
      forceSpotify || decoded.includes(':') ? decoded : rawClean;
    if (spotifyCandidate.startsWith('spotify@') || spotifyCandidate.startsWith('spotify:')) {
      const user = spotifyCandidate.startsWith('spotify@')
        ? parseSpotifyUser(spotifyCandidate)
        : defaultSpotifyUserId ?? 'nouser';
      const folderId = spotifyCandidate
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^spotify:/i, '');
      if (folderId.toLowerCase().startsWith('track:')) {
        const trackId = folderId.split(':').pop() ?? '';
        const track = await this.contentPort.getServiceTrack('spotify', user, trackId);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
      }
      // Fetch full playlist/album in pages of 50.
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await this.contentPort.getServiceFolder('spotify', user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? folder!.totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (maxItems && allItems.length >= maxItems) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? decoded, defaultSpotifyUserId);
      }
    }

    return [];
  }

  public async fillQueueInBackground(
    ctx: ZoneContext,
    resolvedTarget: string,
    zoneName: string,
    station: string | undefined,
    rawAudiopath: string | undefined,
    token: string,
  ): Promise<void> {
    try {
      const fullQueue = await this.buildQueueForUri(resolvedTarget, zoneName, station, rawAudiopath);
      if (!fullQueue.length) {
        return;
      }
      if (ctx.metadata.queueFillToken !== token) {
        return;
      }
      if (ctx.queue.items.length >= fullQueue.length) {
        return;
      }
      const current = ctx.queueController.current()?.audiopath ?? '';
      const normalizedCurrent = normalizeSpotifyAudiopath(current || '');
      const nextIndex = fullQueue.findIndex(
        (item) => normalizeSpotifyAudiopath(item.audiopath) === normalizedCurrent,
      );
      const startIndex = nextIndex >= 0 ? nextIndex : ctx.queueController.currentIndex();
      const prevShuffle = ctx.queue.shuffle;
      const prevRepeat = ctx.queue.repeat;
      ctx.queueController.setItems(fullQueue, startIndex);
      ctx.metadata.queueShuffled = false;
      ctx.queue.shuffle = prevShuffle;
      ctx.queue.repeat = prevRepeat;
      if (ctx.queue.shuffle) {
        this.reorderQueue(ctx, 'shuffle', { keepCurrent: true, shuffleUpcoming: true });
      }
      this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
      this.log.debug('queue filled in background', {
        zoneId: ctx.id,
        items: ctx.queue.items.length,
        startIndex,
      });
    } catch (err) {
      this.log.debug('queue background fill failed', {
        zoneId: ctx.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async resolveTrackDuration(audiopath: string): Promise<number> {
    const match = audiopath.match(/^spotify@([^:]+):track:([^/?#]+)/i) ??
      audiopath.match(/^spotify:track:([^/?#]+)/i);
    if (!match) {
      return 0;
    }
    const user = (match.length === 3 ? match[1] : '') ?? '';
    const trackId = (match.length === 3 ? match[2] : match[1]) ?? '';
    const track = await this.contentPort.getServiceTrack('spotify', user, trackId);
    if (track && typeof track.duration === 'number') {
      const d = Math.round(track.duration);
      return d > 0 ? d : 0;
    }
    return 0;
  }

  public resolveQueueAuthorityFromItems(items: QueueItem[]): QueueAuthority | null {
    for (const item of items) {
      if (this.deps.isMusicAssistantAudiopath(item.audiopath)) {
        return 'musicassistant';
      }
      // Whichever streaming service owns the path is the authority for the queue.
      const provider = this.deps.providerForAudiopath(item.audiopath);
      if (provider) {
        return provider as QueueAuthority;
      }
      if (this.deps.isSpotifyAudiopath(item.audiopath)) {
        return 'spotify';
      }
      if ((item.audiopath || '').toLowerCase().startsWith('airplay://')) {
        return 'airplay';
      }
    }
    return null;
  }

  public seekExistingQueueInternal(ctx: ZoneContext, target: string): boolean {
    if (!target || ctx.queue.items.length === 0) {
      return false;
    }
    const normalizedTarget = normalizeSpotifyAudiopath(target);
    const idx = ctx.queue.items.findIndex(
      (item) =>
        normalizeSpotifyAudiopath(item.audiopath) === normalizedTarget ||
        normalizeSpotifyAudiopath(item.unique_id) === normalizedTarget,
    );
    if (idx < 0) {
      return false;
    }
    // Only record the index change; actual seeking is handled via explicit HTTP commands.
    ctx.queueController.setCurrentIndex(idx);
    this.log.debug('queue seek requested; qindex updated', {
      zoneId: ctx.id,
      target,
      qindex: idx,
    });
    return true;
  }

  // --- Queue mutation commands (refcode parity: add/insert/remove/move/clear/undo) ---

  private static readonly UNDO_DEPTH = 25;

  private static matchesTarget(item: QueueItem, target: string, normalizedTarget: string): boolean {
    return (
      item.unique_id === target ||
      normalizeSpotifyAudiopath(item.unique_id) === normalizedTarget ||
      normalizeSpotifyAudiopath(item.audiopath) === normalizedTarget
    );
  }

  private static findTargetIndex(items: QueueItem[], target: string): number {
    const normalized = normalizeSpotifyAudiopath(target);
    return items.findIndex((item) => QueueController.matchesTarget(item, target, normalized));
  }

  private pushUndoSnapshot(ctx: ZoneContext): void {
    const stack =
      (ctx.metadata.queueUndoStack as Array<{ items: QueueItem[]; currentIndex: number }> | undefined) ?? [];
    stack.push({
      items: ctx.queue.items.map((item) => ({ ...item })),
      currentIndex: ctx.queueController.currentIndex(),
    });
    while (stack.length > QueueController.UNDO_DEPTH) {
      stack.shift();
    }
    ctx.metadata.queueUndoStack = stack;
  }

  private async resolveItemsForUri(ctx: ZoneContext, audiopath: string): Promise<QueueItem[]> {
    if (!audiopath) {
      return [];
    }
    return this.buildQueueForUri(audiopath, ctx.name, undefined, audiopath);
  }

  /**
   * A path arriving from outside, in the identity the core works in.
   *
   * The Loxone client sends a queue edit in the disguised `spotify@bridge-…` form, the same
   * as a play request — but `playContent` translated it and these did not, so the queue could
   * end up holding two spellings of one service depending on how the item got there.
   * Idempotent on anything already service-native, which is what every other caller sends.
   */
  private toCoreAudiopath(audiopath: string): string {
    return toServiceNative(audiopath, this.contentPort.getBridgeRegistry());
  }

  /** Append the resolved item(s) for `audiopath` to the end of the queue. */
  public async appendUri(zoneId: number, audiopath: string): Promise<boolean> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    const items = await this.resolveItemsForUri(ctx, this.toCoreAudiopath(audiopath));
    if (!items.length) {
      return false;
    }
    this.pushUndoSnapshot(ctx);
    const currentIndex = ctx.queueController.currentIndex();
    ctx.queueController.setItems(ctx.queue.items.concat(items), currentIndex);
    this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    this.log.debug('queue append', { zoneId, added: items.length, total: ctx.queue.items.length });
    return true;
  }

  /**
   * Insert the resolved item(s) for `audiopath` directly after the current track.
   * Returns the insertion index (for queueandplay), or -1 on failure. The current
   * track stays selected.
   */
  public async insertUriAfterCurrent(zoneId: number, audiopath: string): Promise<number> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return -1;
    }
    const items = await this.resolveItemsForUri(ctx, this.toCoreAudiopath(audiopath));
    if (!items.length) {
      return -1;
    }
    this.pushUndoSnapshot(ctx);
    const currentIndex = ctx.queueController.currentIndex();
    const insertAt = ctx.queue.items.length ? currentIndex + 1 : 0;
    const next = ctx.queue.items.slice();
    next.splice(insertAt, 0, ...items);
    ctx.queueController.setItems(next, currentIndex);
    this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    this.log.debug('queue insert', { zoneId, added: items.length, insertAt, total: ctx.queue.items.length });
    return insertAt;
  }

  /** Move the queue cursor to `index` (used by queueandplay after insert). */
  public selectIndex(zoneId: number, index: number): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    return ctx.queueController.setCurrentIndex(index) !== null;
  }

  /** Remove the item matching `target` (unique_id or audiopath). */
  public removeByUniqueId(zoneId: number, target: string): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || !target) {
      return false;
    }
    const idx = QueueController.findTargetIndex(ctx.queue.items, target);
    if (idx < 0) {
      return false;
    }
    this.pushUndoSnapshot(ctx);
    const currentIndex = ctx.queueController.currentIndex();
    const next = ctx.queue.items.slice();
    next.splice(idx, 1);
    let newCurrent = currentIndex;
    if (idx < currentIndex) {
      newCurrent = currentIndex - 1;
    } else if (idx === currentIndex) {
      newCurrent = Math.min(currentIndex, next.length - 1);
    }
    ctx.queueController.setItems(next, Math.max(0, newCurrent));
    this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    this.log.debug('queue remove', { zoneId, removedIndex: idx, total: ctx.queue.items.length });
    return true;
  }

  /**
   * Move the item matching `srcTarget` to before the item matching
   * `targetOrEnd` (or to the end when `targetOrEnd === 'end'`). The currently
   * playing track keeps its identity (qindex is recomputed).
   */
  public moveBeforeUniqueId(zoneId: number, srcTarget: string, targetOrEnd: string): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || !srcTarget) {
      return false;
    }
    const from = QueueController.findTargetIndex(ctx.queue.items, srcTarget);
    if (from < 0) {
      return false;
    }
    const isEnd = targetOrEnd === 'end';
    const targetIndex = isEnd ? ctx.queue.items.length : QueueController.findTargetIndex(ctx.queue.items, targetOrEnd);
    if (!isEnd && targetIndex < 0) {
      return false;
    }
    const currentUid = ctx.queueController.current()?.unique_id;
    this.pushUndoSnapshot(ctx);
    const next = ctx.queue.items.slice();
    const [moved] = next.splice(from, 1);
    if (!moved) {
      return false;
    }
    // After removing `from`, indices at/after it shift left by one.
    const insertAt = isEnd ? next.length : targetIndex > from ? targetIndex - 1 : targetIndex;
    next.splice(insertAt, 0, moved);
    const newCurrent = currentUid
      ? next.findIndex((item) => item.unique_id === currentUid)
      : ctx.queueController.currentIndex();
    ctx.queueController.setItems(next, Math.max(0, newCurrent));
    this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    this.log.debug('queue move', { zoneId, from, insertAt, total: ctx.queue.items.length });
    return true;
  }

  /** Empty the queue. Current playback continues until end-of-track. */
  public clear(zoneId: number): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || !ctx.queue.items.length) {
      return false;
    }
    this.pushUndoSnapshot(ctx);
    ctx.queueController.setItems([], 0);
    this.deps.notifier.notifyQueueUpdated(zoneId, 0);
    this.log.debug('queue cleared', { zoneId });
    return true;
  }

  /** Restore the queue to the state before the most recent mutation. */
  public undo(zoneId: number): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    const stack = ctx.metadata.queueUndoStack as
      | Array<{ items: QueueItem[]; currentIndex: number }>
      | undefined;
    const snapshot = stack?.pop();
    if (!snapshot) {
      return false;
    }
    ctx.queueController.setItems(snapshot.items, snapshot.currentIndex);
    this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    this.log.debug('queue undo', { zoneId, total: ctx.queue.items.length });
    return true;
  }

  public reorderQueue(
    ctx: ZoneContext,
    mode: 'shuffle' | 'unshuffle',
    opts: { keepCurrent: boolean; shuffleUpcoming?: boolean },
  ): void {
    if (!ctx.queue.items.length) {
      return;
    }
    let reordered = ctx.queue.items.slice();
    const currentIndex = opts.keepCurrent ? ctx.queueController.currentIndex() : 0;
    if (mode === 'shuffle') {
      if (opts.keepCurrent) {
        if (opts.shuffleUpcoming) {
          const head = reordered.slice(0, currentIndex + 1);
          const tail = reordered.slice(currentIndex + 1);
          for (let i = tail.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [tail[i], tail[j]] = [tail[j]!, tail[i]!];
          }
          reordered = head.concat(tail);
        } else {
          const current = ctx.queueController.current();
          if (!current) {
            return;
          }
          const currentItem = reordered[currentIndex]!;
          const rest = reordered.filter((_, idx) => idx !== currentIndex);
          for (let i = rest.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j]!, rest[i]!];
          }
          const insertAt = clamp(currentIndex, 0, rest.length);
          rest.splice(insertAt, 0, currentItem);
          reordered = rest;
        }
      } else {
        const pickIndex = Math.floor(Math.random() * reordered.length);
        const picked = reordered.splice(pickIndex, 1)[0]!;
        for (let i = reordered.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [reordered[i], reordered[j]] = [reordered[j]!, reordered[i]!];
        }
        reordered = [picked, ...reordered];
      }
    } else {
      if (opts.keepCurrent && opts.shuffleUpcoming) {
        const head = reordered.slice(0, currentIndex + 1);
        const tail = reordered.slice(currentIndex + 1).sort(
          (a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0),
        );
        reordered = head.concat(tail);
      } else {
        reordered = reordered.sort(
          (a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0),
        );
      }
    }
    if (opts.keepCurrent) {
      const current = ctx.queueController.current();
      if (!current) {
        return;
      }
      ctx.queueController.setItems(reordered, currentIndex);
    } else {
      ctx.queueController.setItems(reordered, 0);
    }
    ctx.metadata.queueShuffled = mode === 'shuffle';
    this.deps.applyPatch(ctx.id, {
      qindex: ctx.queueController.currentIndex(),
      plshuffle: ctx.queue.shuffle ? 1 : 0,
    });
    this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
  }
}

/**
 * @internal Exported for the boundary bit-identity test. Collapses core/legacy
 * audiopaths to the `spotify:<kind>:<id>` shape the native getqueue schema
 * requires (fail-hard: an unrecognized item empties the whole queue).
 */
export function sanitizeAudiopathForOutput(audiopath: string): string {
  if (!audiopath) {
    return audiopath;
  }
  // Loxone getqueue payload uses the bare `spotify:<kind>:<id>` form (bridge/
  // account dropped). The native client's queue schema is FAIL-HARD: it requires
  // each streaming item's audiopath to literally start with `spotify:` whose 2nd
  // segment is `track`/`episode` (audiotype 5); an unrecognized item throws the
  // whole `z.array` parse and empties the queue. So collapse both the legacy
  // `spotify@<x>:` disguise and the service-native `<service>[:<slug>]:...` form
  // to `spotify:<kind>:<id>`, mapping the Apple `library-track` alias down to
  // `track` (the client only accepts `track`/`episode` here).
  if (/^spotify@/i.test(audiopath)) {
    const tail = audiopath.replace(/^spotify@[^:]+:/i, '').replace(/^library-/i, '');
    return `spotify:${tail}`;
  }
  const native = parseServiceNativeAudiopath(audiopath);
  // Only the bridged STREAMING services present to Loxone as spotify. `library`,
  // `radio`, `local`, `linein`, etc. are their own native Loxone concepts and
  // must NOT be rewritten to spotify: (that would corrupt library/radio queue
  // items — and the queue schema is fail-hard).
  if (native && BRIDGE_STREAMING_SERVICES.has(native.service)) {
    // Drop the `library-` alias: the queue schema only recognizes `track`/`episode`.
    return `spotify:${native.kind}:${native.id}`;
  }
  return audiopath;
}

/**
 * True when the audiopath points at a directly playable item (a track) rather
 * than a container (album/artist/playlist) that must first be browsed for its
 * tracks. Matches both the plain and Apple `library-` kind forms.
 */
function isPlayableTrackAudiopath(audiopath: string | undefined): boolean {
  if (!audiopath) {
    return false;
  }
  return /:(library-)?track:/i.test(audiopath);
}

/**
 * Strips a `<provider>@<account>:` or `<provider>:` prefix down to the
 * `kind:id` folder id.
 *
 * `spotify` is always stripped because every bridged service also travels in
 * the Loxone-facing `spotify@<bridgeId>:` disguise; `service` names the real
 * one, and must be passed or the path keeps its own prefix and the provider is
 * handed a folder id it cannot resolve.
 */
function stripProviderPrefix(audiopath: string, service?: string): string {
  let stripped = audiopath.replace(/^spotify@[^:]+:/i, '').replace(/^spotify:/i, '');
  if (service) {
    stripped = stripped
      .replace(new RegExp(`^${service}@[^:]+:`, 'i'), '')
      .replace(new RegExp(`^${service}:`, 'i'), '');
  }
  return stripped;
}
