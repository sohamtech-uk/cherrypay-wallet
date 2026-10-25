import { randomUUID } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture, RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/types';

type Credential = { id:string; publicKey:Uint8Array; counter:number; transports?:AuthenticatorTransportFuture[] };
type Account = { id:string; userID:Uint8Array; credentials:Credential[] };
type Pending = { challenge:string; accountID:string; purpose:'register'|'authenticate'; expires:number };
// Development-only in-memory state: restart loses credentials and challenges. Not production persistence.
const accounts = new Map<string,Account>();
const pending = new Map<string,Pending>();
const expiryMs = 120_000;
export function clearDevelopmentState(){ accounts.clear();pending.clear(); }
export function accountSummary(accountID:string){const account=accounts.get(accountID);return account?{id:account.id,credentialCount:account.credentials.length}:null;}
export async function beginRegistration(accountID:string, rpID:string, rpName='Cherry Pay Wallet Testnet'){
 if(!/^[a-zA-Z0-9_-]{8,80}$/.test(accountID))throw new Error('Invalid account identifier');
 let account=accounts.get(accountID);
 if(!account){account={id:accountID,userID:crypto.getRandomValues(new Uint8Array(32)),credentials:[]};accounts.set(accountID,account);}
 const options=await generateRegistrationOptions({rpName,rpID,userID:account.userID,userName:account.id,attestationType:'none',authenticatorSelection:{residentKey:'preferred',userVerification:'required'},excludeCredentials:account.credentials.map(c=>({id:c.id,transports:c.transports}))});
 const requestID=randomUUID();pending.set(requestID,{challenge:options.challenge,accountID,purpose:'register',expires:Date.now()+expiryMs});return {requestID,options};
}
export async function finishRegistration(accountID:string,requestID:string,response:RegistrationResponseJSON,rpID:string,origin:string,token?:string){
 const count=await store.withLockedAccount(accountID,async client=>{
  const challenge=await store.consumeLockedChallenge(client,requestID,accountID,token?'register_backup':'register_initial',token);
  const credentials=await store.credentialsLocked(client,accountID);
  if(token?!credentials.length:!!credentials.length)throw Error('Invalid enrollment state');
  const verified=await verifyRegistrationResponse({response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true});
  if(!verified.verified||!verified.registrationInfo)throw Error('Passkey verification failed');
  const c=verified.registrationInfo.credential;
  await store.addCredentialLocked(client,accountID,{id:c.id,publicKey:c.publicKey,counter:c.counter,transports:response.response.transports});
  return credentials.length+1;
 });
 return {verified:true,accountID,credentialCount:count,recoveryReady:count>=2,...await store.createSession(accountID)};
}
export async function beginAuthentication(accountID:string,rpID:string){
 const credentials=await store.getCredentials(accountID);
 if(!credentials.length)throw Error('Unknown account');
 const options=await generateAuthenticationOptions({rpID,userVerification:'required',allowCredentials:credentials.map(c=>({id:c.id,transports:c.transports as any}))});
 return {requestID:await store.newChallenge(accountID,'authenticate',options.challenge),options};
}
export async function finishAuthentication(accountID:string,requestID:string,response:AuthenticationResponseJSON,rpID:string,origin:string){
 const count=await store.withLockedAccount(accountID,async client=>{
  const challenge=await store.consumeLockedChallenge(client,requestID,accountID,'authenticate');
  const credentials=await store.credentialsLocked(client,accountID),c=credentials.find(x=>x.id===response.id);
  if(!c)throw Error('Unknown credential');
  const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,credential:{id:c.id,publicKey:new Uint8Array(Buffer.from(c.public_key,'base64')),counter:Number(c.counter),transports:c.transports as any},requireUserVerification:true});
  if(!result.verified)throw Error('Authentication failed');
  await store.updateCounterLocked(client,c.id,accountID,Number(c.counter),result.authenticationInfo.newCounter);
  return credentials.length;
 });
 return {verified:true,accountID,credentialCount:count,...await store.createSession(accountID)};
}

