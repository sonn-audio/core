import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import type { ContentManager } from '@/adapters/content/contentManager';
import {
  decodeSegment,
  extractPayload,
  parseNumberPart,
  splitCommand,
} from '@/adapters/loxone/commands/utils/commandUtils';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import { decodeAudiopath } from '@/domain/zones/audiopath';
import { isMusicAssistantAudiopath } from '@/application/zones/internal/zoneAudioHelpers';
import type { PlaybackMetadata } from '@/ports/types/playback';
import { BASE_LIBRARY, BASE_PLAYLIST, decodeLoxoneId } from '@/adapters/loxone/commands/utils/loxoneIdCodec';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { FadeControllerPort } from '@/ports/FadeControllerPort';
import { createLogger } from '@/shared/logging/logger';
import {
  DEFAULT_EQUALIZER_BANDS,
  formatEqualizerSettings,
  getZoneEqualizerBands,
  parseEqualizerSettings,
  resolveEqForwardUrl,
} from '@/domain/zones/equalizer';

const log = createLogger('Loxone', 'ZoneHandlers');

const noopFadeController: FadeControllerPort = {
  parseFadeOptions: () => ({}),
  fadeIn: async () => {},
};

export function createZoneHandlers(
  zoneManager: ZoneManagerFacade,
  recentsManager: RecentsManager,
  favoritesManager: FavoritesManager,
  contentManager: ContentManager,
  configPort?: ConfigPort,
  fadeController: FadeControllerPort = noopFadeController,
) {
  return {
    audioGetStatus: (command: string) => audioGetStatus(zoneManager, command),
    audioCfgGetQueue: (command: string) => audioCfgGetQueue(zoneManager, command),
    audioRecent: (command: string) => audioRecent(recentsManager, command),
    audioPlaylistPlay: (command: string) => audioPlaylistPlay(zoneManager, contentManager, fadeController, command),
    audioLibraryPlay: (command: string) => audioLibraryPlay(zoneManager, contentManager, fadeController, command),
    audioServicePlay: (command: string) => audioServicePlay(zoneManager, contentManager, fadeController, command),
    audioPlayUrl: (command: string) => audioPlayUrl(zoneManager, contentManager, fadeController, command),
    audioCfgGetEq: (command: string) => audioCfgGetEq(configPort, command),
    audioCfgEqualizer: (command: string) => audioCfgEqualizer(zoneManager, configPort, command),
    audioCfgSetEq: (command: string) => audioCfgSetEq(zoneManager, configPort, command),
    audioEqualizerSettings: (command: string) => audioEqualizerSettings(zoneManager, configPort, command),
    audioDynamicCommand: (command: string) => audioDynamicCommand(zoneManager, command),
    audioCfgGetRoomFavs: (command: string) => audioCfgGetRoomFavs(favoritesManager, command),
    audioCfgRoomFavs: (command: string) => audioCfgRoomFavs(favoritesManager, command),
    audioFavoritePlay: (command: string) =>
      audioFavoritePlay(zoneManager, favoritesManager, contentManager, fadeController, command),
    audioRoomFavPlus: (command: string) =>
      audioRoomFavPlus(zoneManager, favoritesManager, contentManager, command),
  };
}

function audioGetStatus(zoneManager: ZoneManagerFacade, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const state = zoneManager.getState(zoneId);
  return buildResponse(command, 'status', state ? [state] : []);
}

function audioCfgGetQueue(zoneManager: ZoneManagerFacade, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const start = parseNumberPart(parts[3], 0);
  const limit = parseNumberPart(parts[4], 50);

  const queue = zoneManager.getQueue(zoneId, start, limit);
  return buildResponse(command, 'getqueue', [
    {
      id: queue.id,
      items: queue.items,
      shuffle: queue.shuffle,
      start: queue.start,
      totalitems: queue.totalitems,
    },
  ]);
}

async function audioRecent(recentsManager: RecentsManager, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const recents = await recentsManager.get(zoneId);
  return buildResponse(command, 'recent', recents ?? {});
}

async function audioPlaylistPlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  fadeController: FadeControllerPort,
  command: string,
) {
  // The Loxone client appends `/noshuffle` for plain play; omitted means shuffle.
  // Mirror the audioServicePlay convention so the queue is shuffled/ordered as
  // the user intended. Applies to all playlist sources (local and bridges).
  const zoneIdForShuffle = parseNumberPart(splitCommand(command)[1], 0);
  const hasNoShuffle = /\/noshuffle(?:\/|$)/i.test(command);
  zoneManager.queue.setPendingShuffle(zoneIdForShuffle, !hasNoShuffle);

  return playToZone(zoneManager, contentManager, fadeController, command, 'playlistplay', (parts) => {
    // Local library playlists arrive as `audio/<zone>/playlist/play/<encId>[/parentid/.../...][/noshuffle]`.
    // If parts[4] decodes as a Loxone-encoded id with a BASE_PLAYLIST offset, rewrite to
    // `library:playlist:<numericId>` so the queue builder expands tracks via getMediaFolder.
    const rawId = parts[4] ?? '';
    const decoded = decodeLoxoneId(rawId);
    if (decoded && typeof decoded.offset === 'number' && decoded.offset >= BASE_PLAYLIST && decoded.offset < BASE_LIBRARY) {
      return `library:playlist:${String(decoded.data)}`;
    }
    return extractPayload(parts.slice(4));
  });
}

async function audioLibraryPlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  fadeController: FadeControllerPort,
  command: string,
) {
  return playToZone(zoneManager, contentManager, fadeController, command, 'libraryplay', (parts) =>
    extractPayload(parts.slice(4)),
  );
}

/**
 * Maps a Loxone parentid folder reference to a Spotify audiopath with provider prefix.
 * Loxone sends parentid/<folderId>/<trackIndex> when clicking a track from a browsed folder.
 * folderId is either a numeric category (e.g. 4 = Liked Songs) or a full Spotify URI.
 * Returns null if the folder has no single playable context (e.g. "all playlists" list).
 */
function folderIdToSpotifyAudiopath(folderId: string, providerPrefix: string): string | null {
  const key = folderId.toLowerCase();
  if (key === '4' || key === 'liked' || key.includes('liked-songs') || key === 'user:collection') {
    return `${providerPrefix}:user:collection`;
  }
  if (key.startsWith('spotify:playlist:') || key.startsWith('playlist:')) {
    return `${providerPrefix}:playlist:${folderId.split(':').pop()}`;
  }
  if (key.startsWith('spotify:album:') || key.startsWith('album:')) {
    return `${providerPrefix}:album:${folderId.split(':').pop()}`;
  }
  if (key.startsWith('spotify:artist:') || key.startsWith('artist:')) {
    return `${providerPrefix}:artist:${folderId.split(':').pop()}`;
  }
  if (key.startsWith('spotify:show:') || key.startsWith('show:')) {
    return `${providerPrefix}:show:${folderId.split(':').pop()}`;
  }
  return null;
}

function resolveParentIdInCommand(command: string): string {
  // /parentid/<folderId>/<trackIndex> — folderId may contain colons but not slashes
  const match = /\/parentid\/([^/]+)\/(\d+)/.exec(command);
  if (!match) {
    return command;
  }
  const folderId = match[1] ?? '';
  const trackIndex = match[2] ?? '';
  // Derive provider prefix from command: audio/{zoneId}/serviceplay/{service}/{user}/...
  const parts = command.split('/');
  const service = parts[3] ?? 'spotify';
  const rawUser = parts[4] ?? '';
  const user = rawUser && rawUser !== 'nouser' ? rawUser : '';
  const providerPrefix = user ? `${service}@${user}` : service;
  const audiopath = folderIdToSpotifyAudiopath(folderId, providerPrefix);
  if (!audiopath) {
    return command;
  }
  return command.replace(match[0], `/parentpath/${audiopath}/${trackIndex}`);
}

async function audioServicePlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  fadeController: FadeControllerPort,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const hasNoShuffle = /\/noshuffle(?:\/|$)/i.test(command);
  zoneManager.queue.setPendingShuffle(zoneId, !hasNoShuffle);
  const resolvedCommand = resolveParentIdInCommand(command);
  const response = await playToZone(zoneManager, contentManager, fadeController, resolvedCommand, 'serviceplay', (parts) => {
    const decoded = extractPayload(parts.slice(4));
    const withoutNouser = decoded.startsWith('nouser/')
      ? decoded.slice('nouser/'.length)
      : decoded;

    const slashIndex = withoutNouser.indexOf('/');
    if (slashIndex > 0) {
      const maybeUser = withoutNouser.slice(0, slashIndex);
      const rest = withoutNouser.slice(slashIndex + 1);
      if (rest.startsWith('spotify@') || rest.startsWith('spotify:')) {
        if (
          rest.startsWith('spotify:') &&
          maybeUser &&
          (/applemusic/i.test(maybeUser) || /deezer/i.test(maybeUser) || /tidal/i.test(maybeUser) || /musicassistant/i.test(maybeUser) || /^bridge-/i.test(maybeUser))
        ) {
          return `spotify@${maybeUser}:${rest.replace(/^spotify:/i, '')}`;
        }
        return rest;
      }
      // The client echoes back a bridged-service item as `<accountId>/<audiopath>`
      // where audiopath is now SERVICE-NATIVE (`applemusic:library-playlist:...`).
      // Rebuild the `spotify@<accountId>:` envelope the intake normalizer
      // (toServiceNative) understands, instead of gluing account+native with a
      // slash (which would land inside the first colon-token and break service
      // resolution for album/playlist/artist container playback).
      if (
        maybeUser &&
        /^(?:bridge-)?(?:applemusic|deezer|tidal|soundcloud|ytmusic|youtube|musicassistant)\b/i.test(maybeUser) &&
        /^(?:applemusic|deezer|tidal|soundcloud|ytmusic|youtube|musicassistant):/i.test(rest)
      ) {
        // Strip the service prefix from the native rest so the envelope carries
        // the kind:id tail, matching the legacy `spotify@<account>:kind:id` shape.
        const tail = rest.slice(rest.indexOf(':') + 1);
        return `spotify@${maybeUser}:${tail}`;
      }
      return `${maybeUser}/${rest}`;
    }

    return withoutNouser;
  });
  return response;
}

async function audioPlayUrl(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  fadeController: FadeControllerPort,
  command: string,
) {
  return playToZone(zoneManager, contentManager, fadeController, command, 'playurl', (parts) => {
    // Loxone occasionally appends `/parentid/<x>/<y>` after the encoded id;
    // strip it so the leading segment is a clean base64url payload that
    // decodeLoxoneId can parse.
    const raw = extractPayload(parts.slice(3)).replace(/\/parentid\/.*$/i, '');
    // Clicking a track inside a local playlist wraps the track audiopath in the
    // Loxone-canonical id (base64url of [<audiopath>, BASE_PLAYLIST + slot]).
    // The inner data may itself carry a `/parentpath/library:playlist:<id>/<slot>`
    // suffix (added by buildPlaylistTrackItem) so the queue rebuilder can
    // expand the full playlist and start at the clicked track.
    const decoded = decodeLoxoneId(raw);
    if (decoded && typeof decoded.data === 'string') {
      return decoded.data;
    }
    return raw;
  });
}

async function audioEqualizerSettings(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort | undefined,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const rawSettings = decodeSegment(parts.slice(3).join('/'));
  const bands = parseEqualizerSettings(rawSettings);

  if (!bands) {
    return buildResponse(command, 'equalizersettings', {
      success: false,
      error: 'invalid-equalizer-settings',
    });
  }

  const updated = await zoneManager.setEqualizerBands(zoneId, bands);
  if (!updated) {
    return buildResponse(command, 'equalizersettings', {
      success: false,
      error: 'zone-not-found',
    });
  }

  const callbackUrl = resolveEqCallbackUrl(configPort, zoneId);
  if (callbackUrl) {
    await forwardEqualizerSettings(callbackUrl, zoneId, updated.bands);
  } else {
    log.debug('equalizer callback not configured; skipping forward', { zoneId });
  }

  return buildResponse(command, 'equalizersettings', {
    success: true,
    bands: updated.bands,
    equalizerSettings: updated.equalizerSettings,
  });
}

function audioCfgGetEq(configPort: ConfigPort | undefined, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const bands = resolveZoneEqualizerBands(configPort, zoneId);
  if (!bands) {
    return buildResponse(command, 'geteq', []);
  }
  return buildResponse(command, 'geteq', buildGetEqPayload(bands));
}

async function audioCfgEqualizer(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort | undefined,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const rawSettings = decodeSegment(parts.slice(4).join('/'));

  if (!rawSettings) {
    const bands = resolveZoneEqualizerBands(configPort, zoneId) ?? [...DEFAULT_EQUALIZER_BANDS];
    return {
      command,
      name: 'equalizer',
      raw: true,
      payload: buildEqualizerRawResponse(command, zoneId, bands),
    };
  }

  const updated = await updateEqualizerBands(zoneManager, configPort, zoneId, rawSettings);
  if (!updated) {
    return buildResponse(command, 'equalizer', {
      success: false,
      error: 'invalid-equalizer-settings',
    });
  }

  return {
    command,
    name: 'equalizer',
    raw: true,
    payload: buildEqualizerRawResponse(command, zoneId, updated.bands),
  };
}

async function audioCfgSetEq(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort | undefined,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const bandId = parts[4];
  const value = parts[5];
  let rawSettings: string | null = null;

  if (value !== undefined) {
    const bands = resolveZoneEqualizerBands(configPort, zoneId);
    const index = Number(bandId);
    const nextValue = Number(value);
    if (!bands || !Number.isInteger(index) || index < 0 || index >= bands.length || !Number.isFinite(nextValue)) {
      return buildEmptyResponse(command);
    }
    const next = [...bands];
    next[index] = nextValue;
    rawSettings = formatEqualizerSettings(next);
  } else if (bandId) {
    rawSettings = decodeSegment(parts.slice(4).join('/'));
  }

  if (!rawSettings) {
    return buildEmptyResponse(command);
  }

  await updateEqualizerBands(zoneManager, configPort, zoneId, rawSettings);
  return buildEmptyResponse(command);
}

function audioDynamicCommand(zoneManager: ZoneManagerFacade, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const cmd = (parts[2] ?? '').toLowerCase();
  const payload = parts.slice(3).join('/');
  zoneManager.handleCommand(zoneId, cmd, payload);
  // Client schema expects `{action:"queueplus"|"queueminus"}` for next/previous.
  if (cmd === 'queueplus' || cmd === 'queueminus') {
    return buildResponse(command, cmd, { action: cmd });
  }
  return buildEmptyResponse(command);
}

async function audioCfgGetRoomFavs(
  favoritesManager: FavoritesManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const start = parseNumberPart(parts[4], 0);
  const limit = parseNumberPart(parts[5], 50);
  const favorites = await favoritesManager.get(zoneId, start, limit);
  return buildResponse(command, 'getroomfavs', [favorites]);
}

async function audioCfgRoomFavs(
  favoritesManager: FavoritesManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const action = (parts[4] ?? '').toLowerCase();
  const rest = parts.slice(5);

  switch (action) {
    case 'add': {
      const title = decodeSegment(rest[0] ?? '');
      const source = decodeSegment(rest.slice(1).join('/'));
      const fav = await favoritesManager.add(zoneId, title, source);
      return buildResponse(command, 'roomfavs_add', { id: fav.id, name: title });
    }
    case 'setid': {
      const oldId = parseNumberPart(rest[0], 0);
      const newId = parseNumberPart(rest[1], 0);
      await favoritesManager.setId(zoneId, oldId, newId);
      return buildResponse(command, 'roomfavs_set', { changed_from: oldId, changed_to: newId });
    }
    case 'setname': {
      const id = parseNumberPart(rest[0], 0);
      const name = decodeSegment(rest.slice(1).join('/'));
      await favoritesManager.setName(zoneId, id, name);
      return buildResponse(command, 'roomfavs_setname', { id, name });
    }
    case 'delete': {
      const id = parseNumberPart(rest[0], 0);
      await favoritesManager.remove(zoneId, id);
      return buildResponse(command, 'roomfavs_delete', { delete_id: id });
    }
    case 'reorder': {
      const order =
        rest[0]?.split(',').map((value) => Number(value)).filter(Boolean) ?? [];
      await favoritesManager.reorder(zoneId, order);
      return buildResponse(command, 'roomfavs_reorder', 'ok');
    }
    case 'copy': {
      const destinations =
        rest[0]?.split(',').map((value) => Number(value)).filter(Boolean) ?? [];
      await favoritesManager.copy(zoneId, destinations);
      return buildResponse(command, 'roomfavs_copy', 'ok');
    }
    default:
      return buildResponse(command, 'roomfavs_error', {});
  }
}

async function audioFavoritePlay(
  zoneManager: ZoneManagerFacade,
  favoritesManager: FavoritesManager,
  contentManager: ContentManager,
  fadeController: FadeControllerPort,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const favoriteId = parseNumberPart(parts[4], 0);
  const fadeOpts = fadeController.parseFadeOptions(command);
  await playFavorite(zoneManager, favoritesManager, contentManager, zoneId, favoriteId);
  if (fadeOpts.fade) {
    const duration = fadeOpts.fadeDurationMs ?? 120_000;
    void fadeController.fadeIn(zoneId, duration);
  }
  return buildResponse(command, 'roomfav', [{ playerid: zoneId, playing_slot: favoriteId }]);
}

async function audioRoomFavPlus(
  zoneManager: ZoneManagerFacade,
  favoritesManager: FavoritesManager,
  contentManager: ContentManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const favorites = await favoritesManager.get(zoneId);
  if (!favorites.items.length) {
    return buildEmptyResponse(command);
  }

  const metadata = zoneManager.getMetadata(zoneId);
  if (!metadata) {
    return buildEmptyResponse(command);
  }
  const state = zoneManager.getState(zoneId);

  const lastFavoriteId = metadata.lastFavoriteId as number | undefined;
  let currentIndex = -1;

  if (typeof lastFavoriteId === 'number') {
    currentIndex = favorites.items.findIndex((item) => item.id === lastFavoriteId);
  } else if (state?.audiopath) {
    currentIndex = favorites.items.findIndex(
      (item) => item.audiopath === state.audiopath,
    );
  }

  const nextIndex =
    currentIndex >= 0
      ? (currentIndex + 1) % favorites.items.length
      : 0;

  const next = favorites.items[nextIndex];
  if (next) {
    await playFavorite(zoneManager, favoritesManager, contentManager, zoneId, next.id);
    metadata.lastFavoriteId = next.id;
  }

  return buildEmptyResponse(command);
}

async function playFavorite(
  zoneManager: ZoneManagerFacade,
  favoritesManager: FavoritesManager,
  contentManager: ContentManager,
  zoneId: number,
  favoriteId: number,
): Promise<void> {
  const favorite = await favoritesManager.getForPlayback(zoneId, favoriteId);
  if (!favorite) {
    return;
  }
  // A stored favourite has a title, an artist and a cover, but never a length: the file it lives in has
  // no field for one. So ask, on the same terms `playToZone` asks — a race against a short timeout, so a
  // slow provider costs latency between tap and audio rather than blocking the play. Without this a
  // favourite started with no length at all and had to be rescued downstream (#350).
  const resolved = await Promise.race([
    contentManager.resolveMetadata(sanitizeMetadataTarget(favorite.audiopath)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 800).unref?.()),
  ]);
  const favoriteMetadata = {
    title: favorite.title ?? favorite.name ?? '',
    artist: favorite.artist ?? '',
    album: favorite.album ?? '',
    coverurl: favorite.coverurl ?? '',
    // The favourite's own fields win for everything the user can see — they are what the row showed
    // and renaming a favourite is meant to stick. Only the length comes from the lookup.
    ...(typeof resolved?.duration === 'number' && resolved.duration > 0
      ? { duration: resolved.duration }
      : {}),
  };
  void zoneManager.playContent(zoneId, favorite.audiopath, 'favorite', favoriteMetadata);
  const ctxMetadata = zoneManager.getMetadata(zoneId);
  if (ctxMetadata) {
    ctxMetadata.lastFavoriteId = favoriteId;
  }
}

async function playToZone(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  fadeController: FadeControllerPort,
  command: string,
  name: string,
  payloadResolver: (parts: string[]) => string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const uri = payloadResolver(parts);
  const fadeOpts = fadeController.parseFadeOptions(command);

  // Detect queue item clicks (no parent context) and pre-seek within the existing queue.
  const looksLikeQueueClick = uri && !uri.includes('/parentpath/') && !uri.includes('/parentid/');
  if (looksLikeQueueClick) {
    const candidates = [uri, decodeAudiopath(uri)].filter(Boolean);
    for (const target of candidates) {
      if (zoneManager.queue.seekInQueue(zoneId, target)) {
        break;
      }
    }
  }

  const metadataTarget = sanitizeMetadataTarget(uri);
  // Race resolveMetadata against a short timeout: fast providers (Spotify, etc.)
  // resolve in <100 ms and get their real metadata. yt-dlp-backed providers
  // (YouTube/ytmusic) take 3-5 s on cold cache; we don't block on those — the
  // PlaybackCoordinator broadcasts a Loading… state and updateMetadata fills in
  // the real title once the queue rebuild resolves it.
  // Music Assistant skips the race entirely: MA delivers track metadata via
  // its state-mirror right after the play_media RPC, so the 0-800 ms race here
  // is just dead latency between tap and audio.
  let metadata: PlaybackMetadata | null = null;
  if (!isMusicAssistantAudiopath(uri)) {
    const metadataPromise = contentManager.resolveMetadata(metadataTarget);
    metadata = await Promise.race([
      metadataPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800).unref?.()),
    ]);
  }
  void zoneManager.playContent(zoneId, uri, name, metadata ?? undefined);
  if (fadeOpts.fade) {
    const duration = fadeOpts.fadeDurationMs ?? 120_000;
    void fadeController.fadeIn(zoneId, duration);
  }
  return buildResponse(command, name, [{ zoneId, uri }]);
}

function sanitizeMetadataTarget(uri: string): string {
  if (!uri) {
    return uri;
  }
  const cleaned = uri
    .replace(/\/parentpath\/.*$/i, '')
    .replace(/\/parentid\/.*$/i, '')
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/+$/, '');
  return decodeAudiopath(cleaned);
}

function resolveEqCallbackUrl(configPort: ConfigPort | undefined, zoneId: number): string | null {
  if (!configPort) {
    return null;
  }
  try {
    const zone = configPort.getConfig().zones.find((entry) => entry.id === zoneId);
    return resolveEqForwardUrl(zone);
  } catch (error) {
    log.warn('equalizer callback lookup failed', {
      zoneId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveZoneEqualizerBands(configPort: ConfigPort | undefined, zoneId: number): number[] | null {
  if (zoneId <= 0) {
    return [...DEFAULT_EQUALIZER_BANDS];
  }
  if (!configPort) {
    return null;
  }
  try {
    const zone = configPort.getConfig().zones.find((entry) => entry.id === zoneId);
    return zone ? [...getZoneEqualizerBands(zone)] : null;
  } catch (error) {
    log.warn('equalizer state lookup failed', {
      zoneId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function updateEqualizerBands(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort | undefined,
  zoneId: number,
  rawSettings: string,
) {
  const bands = parseEqualizerSettings(rawSettings.replace(/^!/, ''));
  if (!bands) {
    return null;
  }

  const updated = await zoneManager.setEqualizerBands(zoneId, bands);
  if (!updated) {
    return null;
  }

  const callbackUrl = resolveEqCallbackUrl(configPort, zoneId);
  if (callbackUrl) {
    await forwardEqualizerSettings(callbackUrl, zoneId, updated.bands);
  } else {
    log.debug('equalizer callback not configured; skipping forward', { zoneId });
  }

  return updated;
}

function buildGetEqPayload(bands: ReadonlyArray<number>): Array<Record<string, number | string>> {
  const names = ['31 Hz', '63 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'];
  return bands.map((value, id) => ({
    id,
    high: 10,
    low: -10,
    step: 0.5,
    value,
    name: names[id] ?? `B${id}`,
  }));
}

function buildEqualizerRawResponse(command: string, zoneId: number, bands: ReadonlyArray<number>): string {
  const entries = bands.map((band, index) => `"B${index}": ${Number(band).toFixed(1)}`).join(',');
  return `{
  "equalizer_result": [
    {
      "playerid": ${Number(zoneId)},
      "equalizer": {
        ${entries}
      }
    }
  ],
  "command": "${command}"
}`;
}

async function forwardEqualizerSettings(
  callbackUrl: string,
  zoneId: number,
  bands: ReadonlyArray<number>,
): Promise<void> {
  try {
    log.debug('forwarding equalizer settings', { zoneId, callbackUrl, bands: [...bands] });
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoneId, bands }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      log.warn('equalizer callback failed', {
        zoneId,
        callbackUrl,
        status: response.status,
      });
    }
  } catch (error) {
    log.warn('equalizer callback failed', {
      zoneId,
      callbackUrl,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
