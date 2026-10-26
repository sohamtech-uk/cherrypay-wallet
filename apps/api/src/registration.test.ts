import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getOrCreateEmailAccount: vi.fn(), createAccount: vi.fn(), getAccount: vi.fn(), getCredentials: vi.fn(), newChallenge: vi.fn(),
  generateRegistrationOptions: vi.fn(), generateAuthenticationOptions: vi.fn(),
}));
vi.mock('./store.js', () => mocks);
vi.mock('@simplewebauthn/server', () => ({ ...mocks, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() }));
import { beginEmailOnboarding, beginRegistration, beginAuthentication } from './registration.js';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.createAccount.mockResolvedValue({ id: 'server-generated-account', webauthn_user_id: Buffer.from('user-id').toString('base64url') });
  mocks.getCredentials.mockResolvedValue([]);
  mocks.newChallenge.mockResolvedValue('persisted-request-id');
  mocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'registration-challenge' });
  mocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'authentication-challenge' });
});
describe('PostgreSQL enrollment wiring regression', () => {
  it('creates the initial account and challenge through the persistent store', async () => {
    expect(await beginRegistration('localhost')).toMatchObject({ accountID: 'server-generated-account', requestID: 'persisted-request-id' });
    expect(mocks.newChallenge).toHaveBeenCalledWith('server-generated-account', 'register_initial', 'registration-challenge', undefined);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({ rpID: 'localhost', supportedAlgorithmIDs: [-7], userID: new Uint8Array(Buffer.from('user-id')) }));
  });
  it('requires an existing session token for backup enrollment and binds it to the stored challenge', async () => {
    mocks.getAccount.mockResolvedValue({ id: 'existing-account', webauthn_user_id: Buffer.from('user-id').toString('base64url') });
    mocks.getCredentials.mockResolvedValue([{ id: 'existing-passkey', transports: ['internal'] }]);
    await expect(beginRegistration('localhost', 'existing-account')).rejects.toThrow('Existing passkey authentication required');
    expect(mocks.newChallenge).not.toHaveBeenCalled();
    await beginRegistration('localhost', 'existing-account', 'verified-session-token');
    expect(mocks.newChallenge).toHaveBeenCalledWith('existing-account', 'register_backup', 'registration-challenge', 'verified-session-token');
    expect(mocks.createAccount).not.toHaveBeenCalled();
  });
  it('uses stored credentials and a persisted challenge for authentication', async () => {
    mocks.getCredentials.mockResolvedValue([{ id: 'existing-passkey', transports: ['internal'] }]);
    expect(await beginAuthentication('existing-account', 'localhost')).toMatchObject({ requestID: 'persisted-request-id' });
    expect(mocks.newChallenge).toHaveBeenCalledWith('existing-account', 'authenticate', 'authentication-challenge');
  });
});


describe('email-first onboarding',()=>{
 beforeEach(()=>{mocks.getOrCreateEmailAccount.mockResolvedValue({id:'alice@example.test',webauthn_user_id:Buffer.from('stable-user').toString('base64url')});});
 it('creates or resumes a first enrollment using the persistent user handle',async()=>{
  expect(await beginEmailOnboarding('localhost','alice@example.test')).toMatchObject({mode:'register',accountID:'alice@example.test'});
  expect(mocks.newChallenge).toHaveBeenCalledWith('alice@example.test','register_initial','registration-challenge',undefined);
 });
 it('selects authentication when credentials already exist, without issuing an enrollment challenge',async()=>{
  mocks.getCredentials.mockResolvedValue([{id:'existing-key',transports:['internal']}]);
  expect(await beginEmailOnboarding('localhost','alice@example.test')).toMatchObject({mode:'authenticate',accountID:'alice@example.test'});
  expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  expect(mocks.newChallenge).toHaveBeenCalledWith('alice@example.test','authenticate','authentication-challenge');
 });
});
