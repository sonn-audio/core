import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  parseTopology,
  readSonosDescription,
  readSonosStatus,
  resolveSonosCoordinatorHost,
} from '../src/adapters/outputs/sonos/sonosDiscovery';

// The Sonos picker listed speakers as "192.168.1.20 - Sonos Beam" or "Living Room (LF,RF)":
// the description's friendlyName names the box, and S2's /status/zp only has a ZoneName with
// the channels glued on. Whatever we call the speaker is also what a zone saves as its
// deviceName and later rediscovers it by, so it has to be the room name and nothing else.

const S2_DESCRIPTION = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>192.168.1.20 - Sonos Beam</friendlyName>
    <modelName>Sonos Beam</modelName>
    <UDN>uuid:RINCON_48A6B8000001400</UDN>
    <roomName>Kids &amp; Guests</roomName>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <friendlyName>Kids &amp; Guests - Sonos Beam Media Renderer</friendlyName>
        <modelName>Sonos Beam</modelName>
        <UDN>uuid:RINCON_48A6B8000001400_MR</UDN>
      </device>
    </deviceList>
  </device>
</root>`;

test('the description names the room the user set, not the address and model', () => {
  const description = readSonosDescription(S2_DESCRIPTION);
  assert.equal(description.roomName, 'Kids & Guests');
  assert.equal(description.model, 'Sonos Beam');
  assert.equal(description.udn, 'RINCON_48A6B8000001400');
  assert.equal(description.friendlyName, '192.168.1.20 - Sonos Beam');
});

test('an S2 status reads as the room, without the stereo pair it is part of', () => {
  const status = readSonosStatus(
    '<ZPSupportInfo><ZPInfo><ZoneName>Living Room (LF,RF)</ZoneName>' +
      '<HouseholdControlID>Sonos_abc</HouseholdControlID></ZPInfo></ZPSupportInfo>',
  );
  assert.equal(status.roomName, 'Living Room');
  assert.equal(status.householdId, 'Sonos_abc');
});

test('a room the user named with brackets keeps them', () => {
  const status = readSonosStatus('<ZoneName>Office (AV)</ZoneName>');
  assert.equal(status.roomName, 'Office (AV)');
});

test('an S1 status still prefers its RoomName', () => {
  const status = readSonosStatus('<ZoneName>Kitchen (SW)</ZoneName><RoomName>Kitchen</RoomName>');
  assert.equal(status.roomName, 'Kitchen');
});

// Bonded speakers showed up in the picker as rooms of their own ("Television · Sonos Sub"), and
// a zone pointed at one sent its audio to a speaker that only follows. The topology came from
// /status/topology, which S2 no longer serves, and a home theatre's Sub and surrounds are
// <Satellite> elements the parser never looked at.

const BEAM = '172.16.0.178';
const SUB = '172.16.0.150';
const LEFT = '172.16.0.117';
const RIGHT = '172.16.0.118';
const KIDS = '172.16.0.104';

const member = (tag: string, uuid: string, host: string, room: string, extra = '') =>
  `<${tag} UUID="${uuid}" Location="http://${host}:1400/xml/device_description.xml" ZoneName="${room}"${extra}`;

const ZONE_GROUP_STATE =
  '<ZoneGroupState><ZoneGroups>' +
  '<ZoneGroup Coordinator="RINCON_BEAM01400" ID="RINCON_BEAM01400:1">' +
  member('ZoneGroupMember', 'RINCON_BEAM01400', BEAM, 'Television', ' HTSatChanMapSet="RINCON_BEAM01400:LF,RF;RINCON_SUB01400:SW">') +
  member('Satellite', 'RINCON_SUB01400', SUB, 'Television', ' Invisible="1"/>') +
  '</ZoneGroupMember></ZoneGroup>' +
  '<ZoneGroup Coordinator="RINCON_LEFT01400" ID="RINCON_LEFT01400:2">' +
  member('ZoneGroupMember', 'RINCON_LEFT01400', LEFT, 'Dining Room', ' ChannelMapSet="RINCON_LEFT01400:LF,LF;RINCON_RIGHT01400:RF,RF"/>') +
  member('ZoneGroupMember', 'RINCON_RIGHT01400', RIGHT, 'Dining Room', ' Invisible="1"/>') +
  '</ZoneGroup>' +
  '<ZoneGroup Coordinator="RINCON_KIDS01400" ID="RINCON_KIDS01400:3">' +
  member('ZoneGroupMember', 'RINCON_KIDS01400', KIDS, 'Kids &amp; Guests', '/>') +
  '</ZoneGroup>' +
  '</ZoneGroups><VanishedDevices></VanishedDevices></ZoneGroupState>';

// What the speaker actually sends: the document escaped inside the SOAP response.
const escapeXml = (xml: string) =>
  xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SOAP_RESPONSE =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
  '<u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">' +
  `<ZoneGroupState>${escapeXml(ZONE_GROUP_STATE)}</ZoneGroupState>` +
  '</u:GetZoneGroupStateResponse></s:Body></s:Envelope>';

function serveTopology() {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; action?: string }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const action = (init?.headers as Record<string, string> | undefined)?.SOAPAction;
    calls.push({ url, action });
    const ok = url.endsWith(':1400/ZoneGroupTopology/Control') && Boolean(action?.includes('#GetZoneGroupState'));
    return { ok, status: ok ? 200 : 404, text: async () => (ok ? SOAP_RESPONSE : '') } as any;
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test('a Sub and the quiet half of a stereo pair are the speakers that only follow', () => {
  const { hosts } = parseTopology(ZONE_GROUP_STATE);
  assert.equal(hosts.get(BEAM)?.passiveSatellite, false);
  assert.equal(hosts.get(SUB)?.passiveSatellite, true, 'a nested <Satellite> follows its soundbar');
  assert.equal(hosts.get(LEFT)?.passiveSatellite, false);
  assert.equal(hosts.get(RIGHT)?.passiveSatellite, true);
  assert.equal(hosts.get(KIDS)?.zoneName, 'Kids & Guests');
});

test('a zone pointed at a Sub plays through the soundbar it belongs to', async () => {
  const stub = serveTopology();
  try {
    assert.equal(await resolveSonosCoordinatorHost({ host: SUB }), BEAM);
    assert.equal(await resolveSonosCoordinatorHost({ host: RIGHT }), LEFT);
    assert.equal(await resolveSonosCoordinatorHost({ host: KIDS }), KIDS);
    assert.deepEqual(
      stub.calls.map((call) => call.url),
      [SUB, RIGHT, KIDS].map((host) => `http://${host}:1400/ZoneGroupTopology/Control`),
      'the topology is asked of the speaker over SOAP, not read from /status/topology',
    );
  } finally {
    stub.restore();
  }
});

test('a speaker that cannot answer for its topology is played as given', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => '' })) as any;
  try {
    assert.equal(await resolveSonosCoordinatorHost({ host: SUB }), SUB);
  } finally {
    globalThis.fetch = original;
  }
});
