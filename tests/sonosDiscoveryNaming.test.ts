import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  readSonosDescription,
  readSonosStatus,
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
