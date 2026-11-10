import type { ContentManager } from '@/adapters/content/contentManager';
import {
  splitCommand,
  parseNumberPart,
  decodeSegment,
} from '@/adapters/loxone/commands/utils/commandUtils';
import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import {
  BASE_PLAYLIST,
  decodeLoxoneId,
  encodeLoxoneId,
} from '@/adapters/loxone/commands/utils/loxoneIdCodec';
import type { ContentFolderItem } from '@/ports/ContentTypes';
import { forLoxoneFolder } from '@/adapters/loxone/commands/utils/loxoneItems';
import { toProviderNode, rootItemsForLoxone } from '@/adapters/loxone/commands/utils/loxoneServiceFolders';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import { decodeBase64Segment, safeJsonParse } from '@/adapters/loxone/commands/utils/payload';
import { decryptWithAudioCfgKey } from '@/adapters/loxone/commands/handlers/configHandlers';
import { createLogger } from '@/shared/logging/logger';
import { ProviderUnavailableError } from '@/adapters/content/providerUnavailable';

const log = createLogger('Loxone', 'ProviderHandlers');

/**
 * How many rows one media-folder answer carries, however few the app asked for.
 *
 * The app turns every answer into a chunk of its own, and when chunks arrive faster
 * than it can draw them it parks them in a queue it drains with `pop()` — newest
 * first. So a backlog is rendered out of order, and the chunk holding the end of the
 * list latches `isFinished`, after which the browser drops every chunk still waiting:
 * `if (contentTypeItems[type].isFinished) return` in its own data-chunk handler.
 *
 * Answering 50 rows at a time out of a library of thousands guarantees that backlog,
 * because a page comes off SQLite in a few milliseconds and a table of hundreds of
 * rows does not draw that fast. The size of the loss then rides on how quickly the
 * device draws, which is exactly what the reporter measured: three clients, one
 * server, three different cut-offs, each a whole number of pages (#347).
 *
 * One answer per folder means there is never a backlog to reorder. The app is happy
 * to be handed more than it asked for — it takes the next start from what it holds,
 * so a single answer that covers the folder simply ends the loop — as long as the
 * rows never outrun `totalitems`, which they cannot: the count and the rows come
 * from the same query.
 *
 * The price is paid in one block instead of spread over a hundred, so it was measured
 * on a library the size of the reported one. Albums and artists are free: 450 rows is
 * 0.14 MB and under 15 ms. The flat track list is what costs — 6293 rows is 3.9 MB and
 * about 90 ms to build, once per folder per cache lifetime. That is a fair trade
 * against a library the app cannot show, but it is the number to revisit if this ever
 * has to grow: it rises with the row count, and every output here buffers far longer
 * than 90 ms.
 */
const MEDIA_FOLDER_ROWS_PER_ANSWER = 10_000;

function normalizeItemId(raw: string | undefined): string {
  const decoded = decodeSegment(raw ?? '').trim();
  return decoded.replace(/\]+$/, '');
}

export function createProviderHandlers(contentManager: ContentManager, notifier: LoxoneWsNotifier) {
  return {
    audioCfgGetAvailableServices: (command: string) => {
      const services = contentManager.getAvailableServices();
      return buildResponse(command, 'getavailableservices', services);
    },
    audioCfgGetServices: (command: string) => {
      const services = contentManager.getServices();
      return buildResponse(command, 'getservices', services);
    },
    audioCfgGetMediaFolder: async (command: string) => {
      const rawParts = splitCommand(command);
      const parts = rawParts[0] === '' ? rawParts.slice(1) : rawParts;
      const folderId = decodeSegment(parts[3] || 'root');
      const start = parseNumberPart(parts[4], 0);
      const requested = parseNumberPart(parts[5], 50);
      // The 50 the app asks for is a floor, not a ceiling — see the constant.
      const limit = Math.max(requested, MEDIA_FOLDER_ROWS_PER_ANSWER);
      const folder = await contentManager.getMediaFolder(folderId, start, limit);
      return buildResponse(command, 'getmediafolder', folder ? [forLoxoneFolder(folder)] : []);
    },
    audioCfgGetRadios: async (command: string) => {
      const radios = await contentManager.getRadios();
      return buildResponse(command, 'getradios', radios);
    },
    // audio/cfg/radios/add — add a custom stream. Two encodings:
    //  - native client: /<name>/<url>[/<auth>] path params (the url spans several
    //    decoded segments, so rejoin everything after the name);
    //  - our player: a single base64url JSON blob {name,url,cover} (lets it carry
    //    a cover, which the path form can't).
    audioCfgRadiosAdd: async (command: string) => {
      const parts = splitCommand(command);
      let name = '';
      let url = '';
      let cover: string | undefined;
      const blob = parts[4]
        ? safeJsonParse<{ name?: string; url?: string; cover?: string }>(
            decodeBase64Segment(decodeURIComponent(parts[4])),
          )
        : null;
      if (blob && typeof blob === 'object' && (blob.name || blob.url)) {
        name = (blob.name ?? '').trim();
        url = (blob.url ?? '').trim();
        cover = blob.cover?.trim() || undefined;
      } else {
        name = parts[4] ? decodeURIComponent(parts[4]) : '';
        url = parts.length > 5 ? decodeURIComponent(parts.slice(5).join('/')) : '';
      }
      // CustomRadioError: NONE=0, INVALID_URL=-1, MISSING_PAYLOAD=-4.
      if (!name || !url) {
        return buildResponse(command, 'radios', { action: 'add', name, url, error: -4 });
      }
      if (!/^https?:\/\//i.test(url)) {
        return buildResponse(command, 'radios', { action: 'add', name, url, error: -1 });
      }
      try {
        const entry = await contentManager.addCustomRadio(name, url, cover);
        return buildResponse(command, 'radios', {
          action: 'add',
          id: entry.id,
          name: entry.name,
          url: entry.stream,
          error: 0,
        });
      } catch {
        return buildResponse(command, 'radios', { action: 'add', name, url, error: 1 });
      }
    },
    // audio/cfg/radios/del/<id> — remove a custom stream.
    audioCfgRadiosDel: async (command: string) => {
      const parts = splitCommand(command);
      const id = parts[4] ? decodeURIComponent(parts[4]) : '';
      const removed = id ? await contentManager.removeCustomRadio(id) : false;
      return buildResponse(command, 'radios', { action: 'del', id, error: removed ? 0 : -3 });
    },
    audioCfgGetPlaylists: async (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? '';
      const user = parts[4] ?? 'nouser';
      if (service === 'lms') {
        // URL: audio/cfg/getplaylists2/lms/<user>/<rootId>/<start>/<length>
        // rootId = '0' → list playlists; rootId encoded → list tracks inside that playlist.
        const rootId = parts[5] ?? '0';
        const start = parseNumberPart(parts[6], 0);
        const limit = parseNumberPart(parts[7], 50);

        const rootDecoded = rootId && rootId !== '0' ? decodeLoxoneId(rootId) : null;
        if (rootDecoded !== null) {
          const playlistId = Number(rootDecoded.data);
          if (Number.isFinite(playlistId)) {
            const playlist = contentManager.getLocalPlaylist(playlistId);
            const folder = await contentManager.getLocalPlaylistItems(playlistId, start, limit);
            const tracks = (folder?.items ?? []).map((track, idx) =>
              buildPlaylistTrackItem(track, start + idx, playlistId),
            );
            return buildResponse(command, 'getplaylists2', [
              {
                id: rootId,
                name: playlist?.name ?? '',
                totalitems: folder?.totalitems ?? tracks.length,
                start,
                items: tracks,
              },
            ]);
          }
        }

        const playlists = await contentManager.getPlaylists(service, user, start, limit);
        const items = playlists.map((entry, idx) => buildPlaylistItem(entry, start + idx));
        return buildResponse(command, 'getplaylists2', [
          { id: rootId, name: 'Playlists', totalitems: items.length, start, items },
        ]);
      }
      const start = parseNumberPart(parts[5], 0);
      const limit = parseNumberPart(parts[6], 50);
      const playlists = await contentManager.getPlaylists(service, user, start, limit);
      return buildResponse(command, 'getplaylists2', playlists);
    },
    audioCfgGetServiceFolder: async (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? '';
      const user = parts[4] ?? 'nouser';
      const rawFolderId = decodeSegment(parts.slice(5, -2).join('/') || 'root');
      const start = parseNumberPart(parts[parts.length - 2], 0);
      const limit = parseNumberPart(parts[parts.length - 1], 50);
      // The app addresses sections by its own slot index; providers publish named
      // nodes. Translate on the way in, and hand the slots back on the way out.
      const folderId = toProviderNode(service, user, rawFolderId);
      let folder: Awaited<ReturnType<ContentManager['getServiceFolder']>>;
      try {
        folder = await contentManager.getServiceFolder(service, user, folderId, start, limit);
      } catch (error) {
        // The Loxone app has no way to show why; an empty folder is the most it can draw. The
        // public API says what happened — see `ProviderUnavailableError`.
        if (!(error instanceof ProviderUnavailableError)) {
          throw error;
        }
        log.warn('service folder refused', { service, user, folderId, reason: error.reason });
        return buildResponse(command, 'getservicefolder', []);
      }
      if (!folder) {
        return buildResponse(command, 'getservicefolder', []);
      }
      const isRoot = folderId === 'root' || folderId === 'start';
      let projected = folder;
      if (isRoot) {
        const items = rootItemsForLoxone(service, user, folder.items ?? []);
        // The count has to follow the list. A provider may publish sections this app
        // has no slot for, so the projection drops some — leaving the provider's own
        // total would advertise rows that are not in the payload.
        projected = { ...folder, items, totalitems: items.length };
      }
      return buildResponse(command, 'getservicefolder', [forLoxoneFolder(projected)]);
    },
    audioCfgRescan: (command: string) => {
      void contentManager.rescanLibrary();
      return buildEmptyResponse(command);
    },
    // The app reads the state off a field: `0 !== data[0].scanning`. A bare number
    // makes that read `undefined`, so the library counts as permanently re-indexing —
    // and a re-indexing library browser throws away every content chunk it is handed,
    // leaving the list at whatever arrived in the first moments (#347).
    audioCfgScanStatus: (command: string) => {
      const status = contentManager.getScanStatus();
      return buildResponse(command, 'scanstatus', [{ scanning: status }]);
    },
    audioCfgStorageList: async (command: string) => {
      const storages = await contentManager.listStorages();
      notifier.notifyStorageListUpdated(storages);
      const result = storages.map((storage) => ({
        id: storage.id,
        name: storage.name,
        server: storage.server,
        folder: storage.folder,
        guest: storage.guest,
        username: storage.username ?? undefined,
        type: storage.type,
      }));
      return buildResponse(command, 'storage', result);
    },
    audioCfgStorageAdd: async (command: string) => {
      const parts = splitCommand(command);
      const encoded = decodeSegment(parts[4]);
      if (!encoded) {
        return buildResponse(command, 'storage', { configerror: 1 });
      }

      const jsonStr = decodeBase64Segment(decodeURIComponent(encoded));
      const payload = safeJsonParse<any>(jsonStr);
      if (!payload || !payload.server || !payload.folder || !payload.name) {
        return buildResponse(command, 'storage', { configerror: 1 });
      }

      const plaintextPassword = decryptWithAudioCfgKey(payload.password) ?? payload.password;

      log.debug('storage add payload (plaintext)', {
        name: payload.name,
        server: payload.server,
        folder: payload.folder,
        guest: !!payload.guest,
        username: payload.username,
        password: plaintextPassword,
        options: payload.options,
      });

      try {
        const storage = await contentManager.addStorage({
          id: payload.id,
          name: payload.name,
          server: payload.server,
          folder: payload.folder,
          guest: !!payload.guest,
          username: payload.username,
          password: plaintextPassword,
          type: payload.type ?? 'cifs',
          options: payload.options,
        });
        notifier.notifyStorageAdded(storage);
        notifier.notifyStorageListUpdated(await contentManager.listStorages());
        void contentManager.rescanLibrary();
        return buildResponse(command, 'storage', {
          configerror: 0,
          id: storage.id,
          name: storage.name,
          server: storage.server,
          folder: storage.folder,
          guest: storage.guest,
          username: storage.username ?? undefined,
        });
      } catch (err) {
        const cfgErr = mapMountErrorToConfigError(err);
        return buildResponse(command, 'storage', {
          configerror: cfgErr,
          id: undefined,
          name: payload?.name,
          server: payload?.server,
          folder: payload?.folder,
          guest: payload?.guest,
          username: payload?.username ?? undefined,
        });
      }
    },
    audioCfgStorageDel: async (command: string) => {
      const parts = splitCommand(command);
      const id = parts[4];
      if (id) {
        try {
          await contentManager.deleteStorage(id);
          notifier.notifyStorageRemoved(id);
          notifier.notifyStorageListUpdated(await contentManager.listStorages());
          void contentManager.rescanLibrary();
          return buildResponse(command, 'storage', { configerror: 0 });
        } catch (err) {
          const cfgErr = mapMountErrorToConfigError(err);
          return buildResponse(command, 'storage', { configerror: cfgErr || 1 });
        }
      }
      return buildResponse(command, 'storage', { configerror: 1 });
    },
    audioCfgIsFollowed: (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? 'spotify';
      const user = parts[4] ?? 'nouser';
      const itemId = normalizeItemId(parts[5]);
      return (async () => {
        const provider = contentManager.resolveServiceProvider(service, user);
        if (!provider) {
          return buildResponse(command, 'isfollowed', {
            action: 'isfollowed',
            id: itemId,
            isfollowed: false,
            isowner: false,
          });
        }
        const state =
          (await provider?.getFollowState?.(service, user, itemId)) ?? {
            isfollowed: false,
            isowner: false,
          };
        return buildResponse(command, 'isfollowed', {
          action: 'isfollowed',
          id: itemId,
          isfollowed: state.isfollowed ?? false,
          isowner: state.isowner ?? false,
        });
      })();
    },
    audioCfgFollow: (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? 'spotify';
      const user = parts[4] ?? 'nouser';
      const itemId = normalizeItemId(parts[5]);
      const provider = contentManager.resolveServiceProvider(service, user);
      void provider?.setFollowState?.(service, user, itemId, true);
      return buildResponse(command, 'follow', { action: 'follow', id: itemId });
    },
    audioCfgUnfollow: (command: string) => {
      const parts = splitCommand(command);
      const service = parts[3] ?? 'spotify';
      const user = parts[4] ?? 'nouser';
      const itemId = normalizeItemId(parts[5]);
      const provider = contentManager.resolveServiceProvider(service, user);
      void provider?.setFollowState?.(service, user, itemId, false);
      return buildResponse(command, 'unfollow', { action: 'unfollow', id: itemId });
    },
  };
}

export function buildPlaylistTrackItem(
  track: ContentFolderItem,
  slot: number,
  playlistId?: number | string,
) {
  const audiopath = track.audiopath ?? track.id ?? '';
  // Embed playlist context so a later `playurl` carries enough info to rebuild
  // the full playlist queue (starting at this slot) instead of degrading to a
  // single-track play with no resolvable metadata. Mirrors the album/parentpath
  // mechanism that already exists in parseParentContext.
  const dataWithContext =
    audiopath && playlistId != null && playlistId !== ''
      ? `${audiopath}/parentpath/library:playlist:${playlistId}/${slot}`
      : audiopath;
  const encodedId = encodeLoxoneId(dataWithContext, BASE_PLAYLIST + slot);
  const name = track.name ?? track.title ?? '';
  return {
    type: 2, // FileType.File
    id: encodedId,
    audiopath: encodedId,
    coverurl: track.coverurl ?? '',
    name,
    title: name,
    artist: track.artist ?? '',
    album: track.album ?? '',
    tag: 'lms',
    uniqueId: String(audiopath),
  };
}

function buildPlaylistItem(
  entry: { id: string; name: string; tracks: number; audiopath: string; coverurl?: string },
  slot: number,
) {
  const numericId = Number(entry.id);
  // Encode without slot offset so the id is stable across pages and matches the
  // id used in `playlistchanged_event` broadcasts (which the client uses to
  // splice deleted/renamed items out of its cache).
  const encodedId = encodeLoxoneId(Number.isFinite(numericId) ? numericId : entry.id, BASE_PLAYLIST);
  return {
    type: 11,
    slot: slot + 1,
    audiopath: encodedId,
    coverurl: entry.coverurl ?? '',
    id: encodedId,
    name: entry.name,
    title: '',
    artist: '',
    album: '',
    station: '',
    unique_id: String(numericId || entry.id),
    audiotype: 0,
    contentType: 'Playlists',
    mediaType: 'playlist',
    plus: '',
    items: entry.tracks,
  };
}

function mapMountErrorToConfigError(err: unknown): number {
  const msg = String(err || '').toLowerCase();
  if (msg.includes('status_logon_failure') || msg.includes('permission denied')) {
    return 12;
  }
  if (msg.includes('no such file or directory')) {
    return 1;
  }
  if (
    msg.includes('host is down') ||
    msg.includes('no route to host') ||
    msg.includes('connection timed out') ||
    msg.includes('connection refused')
  ) {
    return 2;
  }
  return 2;
}
