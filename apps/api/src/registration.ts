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
export async function finishRegistration(accountID:string,requestID:string,response:RegistrationResponseJSON,rpID:string,origin:string){
 const item=pending.get(requestID);pending.delete(requestID);
 if(!item||item.purpose!=='register'||item.accountID!==accountID||item.expires<Date.now())throw new Error('Registration challenge expired or invalid');
 const verification=await verifyRegistrationResponse({response,expectedChallenge:item.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true});
 if(!verification.verified||!verification.registrationInfo)throw new Error('Registration verification failed');
 const account=accounts.get(accountID);if(!account)throw new Error('Account missing');
 const {credential}=verification.registrationInfo;
 if(account.credentials.some(c=>c.id===credential.id))throw new Error('Credential already registered');
 account.credentials.push({id:credential.id,publicKey:credential.publicKey,counter:credential.counter,transports:response.response.transports});
 return {verified:true,credentialCount:account.credentials.length,recoveryReady:account.credentials.length>=2};
}
export async function beginAuthentication(accountID:string,rpID:string){
 const account=accounts.get(accountID);if(!account||account.credentials.length===0)throw new Error('No registered credentials');
 const options=await generateAuthenticationOptions({rpID,userVerification:'required',allowCredentials:account.credentials.map(c=>({id:c.id,transports:c.transports}))});
 const requestID=randomUUID();pending.set(requestID,{challenge:options.challenge,accountID,purpose:'authenticate',expires:Date.now()+expiryMs});return {requestID,options};
}
export async function finishAuthentication(accountID:string,requestID:string,response:AuthenticationResponseJSON,rpID:string,origin:string){
 const item=pending.get(requestID);pending.delete(requestID);
 if(!item||item.purpose!=='authenticate'||item.accountID!==accountID||item.expires<Date.now())throw new Error('Authentication challenge expired or invalid');
 const account=accounts.get(accountID);const credential=account?.credentials.find(c=>c.id===response.id);
 if(!credential)throw new Error('Unknown credential');
 const verification=await verifyAuthenticationResponse({response,expectedChallenge:item.challenge,expectedOrigin:origin,expectedRPID:rpID,credential:{id:credential.id,publicKey:credential.publicKey,counter:credential.counter,transports:credential.transports},requireUserVerification:true});
 if(!verification.verified)throw new Error('Authentication verification failed');
 credential.counter=verification.authenticationInfo.newCounter;
 return {verified:true,accountID,credentialCount:account!.credentials.length};
}

