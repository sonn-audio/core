import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { CommandResult, HandlerFn } from '@/adapters/loxone/commands/types';
import type { ConfigPort } from '@/ports/ConfigPort';

/**
 * Implements the "secure/*" bootstrap endpoints expected by Loxone clients.
 */
export function createSecureHandlers(configPort: ConfigPort) {
  return {
    hello: createHandler((command) => {
      const [, , , publicKey = ''] = command.split('/');
      return buildResponse(command, 'secure_hello', {
        command: 'secure/hello',
        error: 0,
        public_key: publicKey,
      });
    }),
    infoPairing: createHandler((command) => ({
      command,
      name: 'secure_infopairing',
      payload: {
        command: 'secure/infopairing',
        error: -81,
        master: resolveMasterIdentifier(configPort),
        peers: [],
      },
      raw: true,
    })),
    authenticate: createHandler((command) =>
      buildResponse(command, 'authenticate', 'authentication successful'),
    ),
    init: createHandler((command) =>
      buildResponse(command, 'secure_init', {
        command: 'secure/init',
        error: 0,
        jwt: LEGACY_JWT,
      }),
    ),
    /*
     * Removing the Audioserver in Loxone Config makes the Miniserver connect once more, run
     * hello and init, and send `secure/forget/<token>`. Left unanswered, it retries the same
     * token a few seconds later and then drops the connection. sonn keeps no pairing to forget
     * and does not read the token, so this only says yes.
     */
    forget: createHandler((command) =>
      buildResponse(command, 'secure_forget', {
        command: 'secure/forget',
        error: 0,
      }),
    ),
  };
}

function createHandler(fn: (command: string) => CommandResult): HandlerFn {
  return (command) => fn(command);
}

function resolveMasterIdentifier(configPort: ConfigPort): string {
  try {
    const serial = configPort.getSystemConfig().miniserver.serial?.trim();
    return serial ? serial.toUpperCase() : '';
  } catch {
    return '';
  }
}

const LEGACY_JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJleHAiOiAxNjQwNjEwMTQ0LAogICJpYXQiOiAxNjQwNjEwMDg0LAogICJzZXNzaW9uX3Rva2VuIjogIjhXYWh3QWZVTHdFUWNlOVl1MHFJRTlMN1FNa1hGSGJpME05Y2g5dktjZ1lBclBQb2pYSHBTaU5jcTBmVDNscUwiLAogICJzdWIiOiAic2VjdXJlLXNlc3Npb24taW5pdC1zdWNjZXNzIgp9.Zd5M55YPirdugqlGr7u6iB-kM_oFqnvMnpxL8gj58vF2L4ocpSY6S8OB_4f8LeIB2AIYikN5U6R0UALJ3Oahxa0gq9qKDoNrjC7-Q8wAe1rEhDbvdWtaRzmgiHnivrz0cNsyeYGBX8c5Ix6pLI8URGjR1Ox2lbxBt_pVZ-MyEvhVNSJ0-DttclqIAgr_24tVmwe6lleT5eKyBoQVAcGJP-3LSdORKckHTCRw6aaf6sOQ7AtK37SXgnHB6J4g2wErvyw29mMAmDTbR8vZUCmTxgnmhbrks02AZITLaDeGAYTlSASWDSl84L9wkWOWk0pufZIGG0zcXgL8EoWD8cw_fIhbh-LXODEY5251u0DlVtaI_6J6o2j8jy_WvsSqKh-sqqy-ygScwPkLgFua7GNlppaHUGsFaEg0rVdLvVAiIV3mbOGnis1RuWcTWY9iuPVxFTODxkOZNRgZttBb_NFa8lQPJKwwhA33YC1hJ6DE3xEC2rvc4LGE400nLKnELNKpFNsom07JFSQQq8NV3Z1lzTksa8ANdXrV080J8x0c1Bt4dcUyx3lzFE8XG3DsLXCnL2YsJ9ik2jdSBZL8grnoQjqvJWaX3j47P0VM-jaMICVb6QcVP-nNB7k5n1qQGASsbkhcB1nffzE_wLooUe4iLxJQ2dkCM1n7ngXDF6HK0_A';
