/**
 * Translates between the Loxone app's fixed service-folder slots and the named
 * nodes a provider publishes.
 *
 * The Loxone app addresses a streaming service's sections by a numeric index from
 * its own `SpotifyFolder` enum (Features=0, NewReleases=1, Categories=2,
 * MyPlaylists=3, LikedSongs=4, Albums=5, Artists=6, Podcasts=7) — it only knows
 * Spotify, so every service is presented as one. Which of its own sections a
 * service puts in a given slot is a *presentation* decision for this app, not a
 * property of the service, so it lives here rather than in the provider. That
 * keeps providers free to name and extend their own tree: nodes with no slot are
 * simply unreachable from the Loxone app and fully available everywhere else.
 *
 * A service without an entry here passes its folder ids through untouched, so
 * providers can be migrated one at a time.
 */

type ServiceSlots = {
  /** Slot index → the provider node it maps onto. */
  readonly nodes: Readonly<Record<string, string>>;
  /**
   * Whether a root listing goes back to the app as slot indices.
   *
   * Set per service to whatever the app already receives: some services have
   * always answered with the index, others with their own node names. Both work
   * (the app drives its sections from its own enum either way), and which one a
   * given service sends is not something to change without the app in front of
   * you — so this only records it.
   */
  readonly projectRoot: boolean;
};

const SLOT_NODES: Record<string, ServiceSlots> = {
  // Spotify is the service the app was built for, so its sections *are* the enum,
  // in order. The provider no longer knows that — it publishes these names and the
  // order lives here.
  spotify: {
    nodes: {
      '0': 'popular',
      '1': 'new',
      '2': 'genres',
      '3': 'playlists',
      '4': 'liked',
      '5': 'albums',
      '6': 'artists',
      '7': 'podcasts',
    },
    projectRoot: true,
  },
  // Apple Music deliberately fills the first three slots with its recommendation
  // feeds — this mirrors exactly what the provider used to decode internally.
  applemusic: {
    nodes: {
      '0': 'new-releases',
      '1': 'recommended-playlists',
      '2': 'recommended-albums',
      '3': 'playlists',
      '5': 'albums',
      '6': 'artists',
    },
    projectRoot: true,
  },
  // Both YouTube services fill the slots with their own sections; the names mirror
  // exactly what each provider used to decode from the index.
  ytmusic: {
    nodes: {
      '0': 'popular',
      '1': 'new-releases',
      '2': 'genres',
      '3': 'playlists',
      '5': 'albums',
      '6': 'artists',
    },
    projectRoot: true,
  },
  youtube: {
    nodes: {
      '0': 'trending',
      '1': 'new-releases',
      '2': 'genres',
      '3': 'playlists',
    },
    projectRoot: true,
  },
  soundcloud: {
    nodes: {
      '0': 'trending',
      '1': 'top',
      '3': 'playlists',
      '4': 'likes',
    },
    projectRoot: true,
  },
  // Amazon Music's library is its playlists: the account's own in My Playlists, the ones it
  // follows beside them in the slot the app shows as liked. Everything else is search.
  amazonmusic: {
    nodes: {
      '3': 'playlists',
      '4': 'followed-playlists',
    },
    projectRoot: false,
  },
  // Deezer's four chart feeds and Music Assistant's library sections have always
  // gone out under their own names, so they stay that way (projectRoot: false).
  deezer: {
    nodes: {
      '0': 'top-tracks',
      '1': 'top-albums',
      '2': 'top-artists',
      '3': 'top-playlists',
    },
    projectRoot: false,
  },
  // Music Assistant is half migrated on purpose: its three library sections are
  // named, but it still hands its recommendation groups to the app under the
  // remaining slot numbers itself. Adding one of those numbers here would take a
  // recommendation away from it, so the table stops at the library sections —
  // which is the shadowing order the provider already had.
  musicassistant: {
    nodes: {
      '3': 'playlists',
      '5': 'albums',
      '6': 'artists',
    },
    projectRoot: false,
  },
};

/** `bridge-applemusic-p0gngd` → `applemusic`. Empty when it isn't a bridge id. */
export function providerTypeFromBridgeId(bridgeId: string): string {
  const match = /^bridge-([^-]+)-/.exec(bridgeId.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Which service a command is really for.
 *
 * Everything but Spotify reaches the app disguised as Spotify, so the `service`
 * part of the command says `spotify` for all of them; the bridge id in `user` is
 * what names the real service. A non-bridge user means the service part is the
 * truth — real Spotify, or a service the app addresses directly.
 */
export function serviceTypeFor(service: string, user: string): string {
  return providerTypeFromBridgeId(user) || service.trim().toLowerCase();
}

/** Inbound: the app's slot index becomes the provider's node name. */
export function toProviderNode(service: string, user: string, folderId: string): string {
  const entry = SLOT_NODES[serviceTypeFor(service, user)];
  if (!entry) {
    return folderId;
  }
  return entry.nodes[folderId.trim()] ?? folderId;
}

/**
 * Outbound: a root listing goes back with the ids the app expects.
 *
 * For a service that addresses its sections by index, a node the app cannot ask
 * for must not appear in the listing — it would fill one of the app's fixed
 * sections with content it can never reach. Those nodes are dropped from the
 * Loxone view and stay visible to every other consumer.
 */
export function rootItemsForLoxone<T extends { id: string }>(
  service: string,
  user: string,
  items: readonly T[],
): T[] {
  const entry = SLOT_NODES[serviceTypeFor(service, user)];
  if (!entry?.projectRoot) {
    return [...items];
  }
  const slotByNode = new Map(Object.entries(entry.nodes).map(([slot, node]) => [node, slot]));
  const out: T[] = [];
  for (const item of items) {
    const slot = slotByNode.get(item.id);
    if (slot !== undefined) {
      out.push({ ...item, id: slot });
    }
  }
  return out;
}
