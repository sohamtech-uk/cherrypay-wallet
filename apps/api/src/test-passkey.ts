/** Synthetic WebAuthn fixtures for tests; these do not represent a physical device. */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
export function testPasskey(algorithm: 'ES256' | 'EdDSA' = 'ES256') {
  const keys = algorithm === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('ed25519');
  const jwk = keys.publicKey.export({ format: 'jwk' }), credential = randomBytes(32), id = credential.toString('base64url');
  const cose = algorithm === 'ES256'
    ? new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]])
    : new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, 'base64url')]]);
  const rpHash = createHash('sha256').update('wallet.example').digest();
  return {
    id,
    registration(challenge: string, origin = 'https://wallet.example', verified = true) {
      const length = Buffer.alloc(2); length.writeUInt16BE(credential.length);
      const authData = Buffer.concat([rpHash, Buffer.from([verified ? 0x45 : 0x41]), Buffer.alloc(4 + 16), length, credential, isoCBOR.encode(cose)]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })).toString('base64url');
      const attestationObject = Buffer.from(isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array>([['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(authData)]]))).toString('base64url');
      return { id, rawId: id, type: 'public-key' as const, response: { clientDataJSON, attestationObject, transports: ['internal' as const] }, clientExtensionResults: {} };
    },
    authentication(challenge: string, counter = 1) {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://wallet.example', crossOrigin: false }));
      const auth = Buffer.concat([rpHash, Buffer.from([5]), Buffer.alloc(4)]); auth.writeUInt32BE(counter, 33);
      const signature = sign(algorithm === 'ES256' ? 'sha256' : null, Buffer.concat([auth, createHash('sha256').update(client).digest()]), keys.privateKey);
      return { id, rawId: id, type: 'public-key' as const, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') }, clientExtensionResults: {} };
    },
  };
}
