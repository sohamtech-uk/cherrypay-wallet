/** Synthetic cryptographic fixtures only; never deployed or funded by unit tests. */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Keypair } from '@stellar/stellar-sdk';
import { deploymentDescriptor } from '../automatic-deployment-chain.js';

export function deploymentFixture() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const cose = new Map<number, number | Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]);
  const credential = { id: randomBytes(32).toString('base64url'), public_key: Buffer.from(isoCBOR.encode(cose)).toString('base64') };
  const owner = `${randomUUID()}@example.test`, deployer = Keypair.random();
  return { owner, credential, deployer, descriptor: deploymentDescriptor(owner, credential, deployer.publicKey()) };
}
