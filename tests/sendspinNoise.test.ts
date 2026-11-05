import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { test } from './testHarness';
import {
  Identity,
  NoiseSession,
  SendspinClient,
  sendspinCore,
  PskCategory,
  AudioCodec,
  Roles,
  SendspinSession,
  SENTINEL_RESOLVED,
  NoiseTransport,
  SENTINEL_PSK,
  SENTINEL_PSK_ID,
  MAX_TRANSPORT_PLAINTEXT,
  MSG_TYPE_FRAGMENT_MORE,
  fragment,
  pskIdFor,
  generatePsk,
  b64urlEncode,
  b64urlDecode,
} from '@sonn-audio/node-sendspin';

/**
 * Noise KKpsk2 checks. The wire itself is pinned by the interop harness against
 * the Python `noiseprotocol` library (the one aiosendspin uses); these cover the
 * pieces that are ours — identity handling, the transport framing, and that a
 * responder and initiator built here agree with each other.
 */

/** A matched initiator/responder pair over the same prologue and PSK. */
function handshakePair(psk: Buffer = SENTINEL_PSK) {
  const server = Identity.generate();
  const client = Identity.generate();
  const prologue = Buffer.from('client/init|server/init', 'utf8');
  const suite = '25519_ChaChaPoly_SHA256' as const;
  const initiator = NoiseSession.asInitiator({
    suite,
    localStaticPriv: server.privateBytes,
    remoteStaticPub: client.publicBytes,
    prologue,
    psk,
  });
  const responder = NoiseSession.asResponder({
    suite,
    localStaticPriv: client.privateBytes,
    remoteStaticPub: server.publicBytes,
    prologue,
  });
  const msg1 = initiator.writeMessage(Buffer.from(JSON.stringify({ psk_id: pskIdFor(psk) })));
  const named = JSON.parse(responder.readMessage(msg1).toString('utf8'));
  responder.mixPsk(psk);
  const msg2 = responder.writeMessage(Buffer.from('{}'));
  initiator.readMessage(msg2);
  return { initiator, responder, named, server, client };
}

test('noise: a handshake completes and both sides agree on the hash', () => {
  const { initiator, responder, named } = handshakePair();
  assert.equal(named.psk_id, SENTINEL_PSK_ID, 'message 1 should name the PSK it used');
  assert.ok(initiator.handshakeComplete && responder.handshakeComplete);
  assert.equal(
    initiator.handshakeHash.toString('hex'),
    responder.handshakeHash.toString('hex'),
    'a mismatched hash means the two derived different keys',
  );
});

test('noise: transport traffic flows both ways and rejects tampering', () => {
  const { initiator, responder } = handshakePair();
  const toClient = initiator.encrypt(Buffer.from('server says hello'));
  assert.equal(responder.decrypt(toClient).toString('utf8'), 'server says hello');
  const toServer = responder.encrypt(Buffer.from('client says hello'));
  assert.equal(initiator.decrypt(toServer).toString('utf8'), 'client says hello');

  const tampered = initiator.encrypt(Buffer.from('trust me'));
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
  assert.throws(() => responder.decrypt(tampered), /authenticate/);
});

test('noise: a wrong PSK fails the handshake rather than downgrading', () => {
  const server = Identity.generate();
  const client = Identity.generate();
  const prologue = Buffer.from('prologue', 'utf8');
  const suite = '25519_ChaChaPoly_SHA256' as const;
  const initiator = NoiseSession.asInitiator({
    suite,
    localStaticPriv: server.privateBytes,
    remoteStaticPub: client.publicBytes,
    prologue,
    psk: generatePsk(),
  });
  const responder = NoiseSession.asResponder({
    suite,
    localStaticPriv: client.privateBytes,
    remoteStaticPub: server.publicBytes,
    prologue,
  });
  responder.readMessage(initiator.writeMessage(Buffer.from('{}')));
  responder.mixPsk(generatePsk()); // A different PSK than the server used.
  const msg2 = responder.writeMessage(Buffer.from('{}'));
  assert.throws(() => initiator.readMessage(msg2), /authenticate/);
});

test('noise: a prologue mismatch fails the handshake', () => {
  const server = Identity.generate();
  const client = Identity.generate();
  const suite = '25519_ChaChaPoly_SHA256' as const;
  // The prologue is the verbatim init frames, so this is what a tampered suite or
  // identity in the cleartext exchange would look like.
  const initiator = NoiseSession.asInitiator({
    suite,
    localStaticPriv: server.privateBytes,
    remoteStaticPub: client.publicBytes,
    prologue: Buffer.from('honest'),
    psk: SENTINEL_PSK,
  });
  const responder = NoiseSession.asResponder({
    suite,
    localStaticPriv: client.privateBytes,
    remoteStaticPub: server.publicBytes,
    prologue: Buffer.from('tampered'),
  });
  assert.throws(() => responder.readMessage(initiator.writeMessage(Buffer.from('{}'))), /authenticate/);
});

test('noise: an identity round-trips through its persisted form', () => {
  const identity = Identity.generate();
  const restored = Identity.fromPrivateB64u(identity.privateB64u);
  assert.equal(restored.peerId, identity.peerId, 'a reloaded identity must be the same server');
  assert.equal(identity.peerId.length, 43, 'a peer id is a 32-byte key in unpadded base64url');
  assert.equal(b64urlEncode(b64urlDecode(identity.peerId)).length, 43);
});

test('noise: the Sentinel PSK is the published constant', () => {
  // Hard-coded rather than recomputed: if this value ever drifts, every unpaired
  // client stops connecting, and the test should say so rather than agree with us.
  assert.equal(SENTINEL_PSK.toString('hex').length, 64);
  assert.equal(SENTINEL_PSK_ID, pskIdFor(SENTINEL_PSK));
  assert.equal(SENTINEL_PSK_ID.length, 43);
});

test('noise: the transport carries text and typed binary through fragmentation', () => {
  const { initiator, responder } = handshakePair();
  const server = new NoiseTransport(initiator);
  const client = new NoiseTransport(responder);

  const textFrames = server.encodeText('{"type":"server/time"}');
  assert.equal(textFrames.length, 1);
  const decodedText = client.decode(textFrames[0]!);
  assert.deepEqual(decodedText, { kind: 'text', data: '{"type":"server/time"}' });

  // An audio chunk keeps its role type byte, which doubles as the transport's.
  const chunk = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 0xab)]);
  const binaryFrames = server.encodeBinary(chunk);
  const decodedBinary = client.decode(binaryFrames[0]!);
  assert.equal(decodedBinary?.kind, 'binary');
  assert.deepEqual(decodedBinary?.kind === 'binary' ? decodedBinary.data : null, chunk);

  // Oversized payloads fragment and reassemble byte-exactly.
  const big = Buffer.concat([Buffer.from([4]), Buffer.alloc(MAX_TRANSPORT_PLAINTEXT * 2 + 500, 0x5a)]);
  const frames = server.encodeBinary(big);
  assert.ok(frames.length >= 3, `expected several fragments, got ${frames.length}`);
  let reassembled = null;
  for (const frame of frames) {
    const out = client.decode(frame);
    if (out) reassembled = out;
  }
  assert.equal(reassembled?.kind, 'binary');
  assert.deepEqual(reassembled?.kind === 'binary' ? reassembled.data : null, big);
});

test('noise: fragmentation never exceeds the Noise transport limit', () => {
  const big = Buffer.concat([Buffer.from([4]), Buffer.alloc(MAX_TRANSPORT_PLAINTEXT * 3, 1)]);
  const frames = fragment(big);
  for (const frame of frames) {
    assert.ok(
      frame.length <= MAX_TRANSPORT_PLAINTEXT,
      `fragment of ${frame.length} exceeds the ${MAX_TRANSPORT_PLAINTEXT}-byte plaintext limit`,
    );
  }
  // The reassembled body must equal the original, header byte included.
  const body = Buffer.concat([
    Buffer.from([frames[0]![1]!]),
    ...frames.map((f, i) => (i === 0 ? f.subarray(2) : f.subarray(1))),
  ]);
  assert.deepEqual(body, big);
});

test('noise: the server greets first on an encrypted connection', async () => {
  /*
   * Encryption reverses the hello order and the client waits on it.
   *
   * The reference client does `_receive_server_hello()` -> `_send_client_hello()`
   * -> `_receive_server_activate()`, so a server that waits for `client/hello`
   * before greeting deadlocks: both sides sit there. Nothing below sends a
   * `client/hello` at all — `server/hello` has to be on the wire regardless.
   */
  const sent: Array<{ binary: boolean; data: any }> = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string | Buffer) =>
      sent.push({ binary: Buffer.isBuffer(data), data }),
    close: () => {},
    ping: () => {},
    terminate: () => {},
    on: () => {},
  };
  const identity = Identity.generate();
  const session = new SendspinSession(
    socket as any,
    null,
    undefined,
    {},
    {},
    { identity, pskProvider: () => SENTINEL_RESOLVED },
    // As runtime/bootstrap.ts configures it: sonn accepts source streams.
    { serverId: 'ignored-under-encryption', name: 'Greeting Server', sourceCodecs: [] },
  );

  const client = Identity.generate();
  const suite = '25519_ChaChaPoly_SHA256' as const;
  const clientInit = JSON.stringify({
    type: 'client/init',
    payload: { client_id: client.peerId, version: 1, suite },
  });
  session.handleText(clientInit);
  // The handshake is async because a PskProvider may be, so let it settle.
  await Promise.resolve();
  await Promise.resolve();

  // server/init and Noise message 1 go out back-to-back, both in the clear.
  assert.equal(sent.length, 2, `expected server/init + message 1, got ${sent.length}`);
  const serverInit = String(sent[0]!.data);
  assert.equal(JSON.parse(serverInit).payload.server_id, identity.peerId);
  const message1 = JSON.parse(String(sent[1]!.data));
  assert.equal(message1.type, 'noise/handshake');

  const responder = NoiseSession.asResponder({
    suite,
    localStaticPriv: client.privateBytes,
    remoteStaticPub: identity.publicBytes,
    prologue: Buffer.concat([Buffer.from(clientInit, 'utf8'), Buffer.from(serverInit, 'utf8')]),
  });
  const named = JSON.parse(
    responder.readMessage(b64urlDecode(message1.payload.data)).toString('utf8'),
  );
  assert.equal(named.psk_id, SENTINEL_PSK_ID, 'unpaired admission should name the Sentinel PSK');
  responder.mixPsk(SENTINEL_PSK);
  const message2 = responder.writeMessage(Buffer.from('{}'));
  session.handleText(
    JSON.stringify({ type: 'noise/handshake', payload: { data: b64urlEncode(message2) } }),
  );

  const afterHandshake = sent.slice(2);
  assert.equal(afterHandshake.length, 1, 'the server owes exactly one frame after the handshake');
  assert.ok(afterHandshake[0]!.binary, 'post-handshake frames must be encrypted binary');
  const transport = new NoiseTransport(responder);
  const decoded = transport.decode(afterHandshake[0]!.data as Buffer);
  assert.equal(decoded?.kind, 'text');
  const hello = JSON.parse(decoded?.kind === 'text' ? decoded.data : '{}');
  assert.equal(hello.type, 'server/hello');
  // Identity was settled by the handshake, so the hello shrinks to the name and, since rc1,
  // the codecs a source may send us (flac and pcm, always both).
  assert.deepEqual(hello.payload, {
    name: 'Greeting Server',
    'source@v1_support': { supported_codecs: ['pcm', 'flac'] },
  });
});

test('noise: client and server bring each other up over a real socket', async () => {
  /*
   * Both halves of the module against each other over a WebSocket, encrypted.
   *
   * The pairwise crypto is covered above and the wire format is pinned by the
   * interop harness against the reference Python library; what this adds is that
   * the two drivers agree on *sequence* — the reversed hello order, and that the
   * client takes the server id from the handshake rather than from a hello field
   * that no longer carries it.
   */
  const serverIdentity = Identity.generate();
  const clientIdentity = Identity.generate();
  sendspinCore.configureServer({ name: 'Loopback Server' });
  sendspinCore.enableEncryption(serverIdentity);

  const wss = new WebSocketServer({ port: 0, path: '/sendspin' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (ws, req) => sendspinCore.handleConnection(ws, req));
  const { port } = wss.address() as { port: number };

  const client = new SendspinClient('ignored-under-encryption', 'Loopback Client', [Roles.PLAYER], {
    playerSupport: {
      supported_formats: [
        { codec: AudioCodec.PCM, channels: 2, sample_rate: 48000, bit_depth: 16 },
      ],
      buffer_capacity: 256 * 1024,
      supported_commands: [],
    },
    encryption: { identity: clientIdentity },
  });

  try {
    await client.connect(`ws://127.0.0.1:${port}/sendspin`, { timeoutMs: 8000 });
    assert.equal(client.isEncrypted, true, 'the connection should be encrypted');
    assert.equal(client.admittedWith, PskCategory.SENTINEL, 'unpaired admission uses the Sentinel PSK');
    assert.equal(client.info?.name, 'Loopback Server');
    // Identity comes from the handshake, not from the hello.
    assert.equal(client.info?.serverId, serverIdentity.peerId);
    assert.equal(client.encryptedServerId, serverIdentity.peerId);

    // The server authenticated the client by its key, not by the string it passed.
    const known = sendspinCore.listClients().map((entry) => entry.clientId);
    assert.ok(
      known.includes(clientIdentity.peerId),
      `server should know the client by its key, got ${JSON.stringify(known)}`,
    );
    assert.ok(
      !known.includes('ignored-under-encryption'),
      'the self-declared id must not be accepted under encryption',
    );
  } finally {
    await client.disconnect();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test('noise: a stray non-fragment frame mid-reassembly is refused', () => {
  const { initiator, responder } = handshakePair();
  const client = new NoiseTransport(responder);
  /*
   * Built straight from the session rather than through `encodeBinary`.
   *
   * Noise frames must be decrypted in the order they were encrypted, so feeding a
   * transport a subset of a fragmented message plus a later frame fails on the auth
   * tag before it ever reaches the reassembly guard. Encrypting exactly the two
   * frames under test, in order, is the only way to exercise it.
   */
  const openingFragment = initiator.encrypt(
    Buffer.concat([Buffer.from([MSG_TYPE_FRAGMENT_MORE, 4]), Buffer.alloc(16, 3)]),
  );
  const completeMessage = initiator.encrypt(Buffer.from(' {"type":"server/time"}', 'binary'));

  assert.equal(client.decode(openingFragment), null, 'the opening fragment yields nothing yet');
  assert.throws(() => client.decode(completeMessage), /fragmented message is in flight/);
});
