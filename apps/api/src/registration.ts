import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import type {RegistrationResponseJSON,AuthenticationResponseJSON} from '@simplewebauthn/server';
import * as store from './store.js';
export async function beginRegistration(rpID:string,accountID?:string,token?:string){
 const account=accountID?await store.getAccount(accountID):await store.createAccount();
 if(!account)throw Error('Account not found');
 const credentials=await store.getCredentials(account.id);
 if(accountID&&(!token||!credentials.length))throw Error('Existing passkey authentication required');
 const options=await generateRegistrationOptions({rpName:'Cherry Pay Wallet Testnet',rpID,userID:new Uint8Array(Buffer.from(account.webauthn_user_id,'base64url')),userName:account.id,attestationType:'none',authenticatorSelection:{residentKey:'preferred',userVerification:'required'},excludeCredentials:credentials.map(c=>({id:c.id,transports:c.transports as any}))});
 return {accountID:account.id,requestID:await store.newChallenge(account.id,accountID?'register_backup':'register_initial',options.challenge,token),options};
}
export async function finishRegistration(accountID:string,requestID:string,response:RegistrationResponseJSON,rpID:string,origin:string,token?:string){
 const challenge=await store.consumeChallenge(requestID,accountID,token?'register_backup':'register_initial',token);
 const credentials=await store.getCredentials(accountID);
 if(token?!credentials.length:!!credentials.length)throw Error('Invalid enrollment state');
 const verified=await verifyRegistrationResponse({response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true});
 if(!verified.verified||!verified.registrationInfo)throw Error('Passkey verification failed');
 const c=verified.registrationInfo.credential;
 await store.addCredential(accountID,{id:c.id,publicKey:c.publicKey,counter:c.counter,transports:response.response.transports});
 return {verified:true,accountID,credentialCount:credentials.length+1,recoveryReady:credentials.length>=1,...await store.createSession(accountID)};
}
export async function beginAuthentication(accountID:string,rpID:string){
 const credentials=await store.getCredentials(accountID);
 if(!credentials.length)throw Error('Unknown account');
 const options=await generateAuthenticationOptions({rpID,userVerification:'required',allowCredentials:credentials.map(c=>({id:c.id,transports:c.transports as any}))});
 return {requestID:await store.newChallenge(accountID,'authenticate',options.challenge),options};
}
export async function finishAuthentication(accountID:string,requestID:string,response:AuthenticationResponseJSON,rpID:string,origin:string){
 const challenge=await store.consumeChallenge(requestID,accountID,'authenticate');
 const credentials=await store.getCredentials(accountID),c=credentials.find(x=>x.id===response.id);
 if(!c)throw Error('Unknown credential');
 const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,credential:{id:c.id,publicKey:new Uint8Array(Buffer.from(c.public_key,'base64')),counter:Number(c.counter),transports:c.transports as any},requireUserVerification:true});
 if(!result.verified)throw Error('Authentication failed');
 await store.updateCounter(c.id,accountID,Number(c.counter),result.authenticationInfo.newCounter);
 return {verified:true,accountID,credentialCount:credentials.length,...await store.createSession(accountID)};
}
