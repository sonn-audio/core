export interface AudioSyncEventPlayer {
  id: string;
  playerid: number;
  name: string;
}

export interface AudioSyncGroupPayload {
  group: string;
  mastervolume: number;
  players: AudioSyncEventPlayer[];
  type: 'dynamic';
}

/**
 * Where a group comes from.
 *
 * - `manual`: made by a user (Loxone app, public API) and kept in `groups.audioGroups`.
 * - `backend`: reported by an outside system that keeps it itself.
 * - `fixed`: a Loxone fixed group ("Audio Player Gruppe fixed"), configured in Loxone Config
 *   and handed to us in the Miniserver's audioserver config. The Miniserver is its source of
 *   truth: it is never persisted, never announced as a dynamic group, and no ungroup command
 *   dissolves it. See `GroupManager.reconcileFixedGroups`.
 */
export type GroupSource = 'manual' | 'backend' | 'fixed';

/** A fixed group as the Miniserver's config describes it, already narrowed to our zones. */
export interface FixedGroupDefinition {
  /** The group's uuid in the Loxone config. */
  externalId: string;
  /** The first of its players that is one of our zones. */
  leader: number;
  /** All of its players that are our zones, leader first. */
  members: number[];
}

/**
 * Single audio group definition tracked in memory.
 */
export interface GroupRecord {
  /** Leader zone ID (controlling player) */
  leader: number;
  /** Members (always includes the leader) */
  members: number[];
  /** Backend identifier (e.g., BeoLink, MusicAssistant) */
  backend: string;
  /** Optional external ID coming from a backend or HTTP request */
  externalId?: string;
  /** Source of the group definition */
  source: GroupSource;
  /** Last modification timestamp */
  updatedAt: number;
}

export type GroupChangeEvent = 'new' | 'update' | 'remove';

export type GroupChangeListener = (
  event: GroupChangeEvent,
  leader: number,
  record?: GroupRecord,
) => void;
