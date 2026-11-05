/**
 * Service id stamped on every container this server hands a Sonos speaker. The speaker reports it
 * back in its playback metadata, which is how the state controller tells our own stream apart from
 * something started in the Sonos app.
 */
export const SONOS_OWN_CONTAINER_SERVICE_ID = 'sonn';
