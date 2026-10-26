import { StrKey } from '@stellar/stellar-sdk';
export const NETWORK = 'TESTNET' as const;
export const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
export type WalletSnapshot = { address: string; balance: string; loading: boolean; error?: string };
export function validateClassicAddress(address: string): boolean { return StrKey.isValidEd25519PublicKey(address); }
export function validateContractAddress(address: string): boolean { return StrKey.isValidContract(address); }
export function isSupportedWalletAddress(address: string): boolean { return validateClassicAddress(address) || validateContractAddress(address); }
export async function loadBalance(address: string, signal?: AbortSignal): Promise<string> {
  if (!validateClassicAddress(address)) throw new Error('Watch-only lookup supports classic G-addresses. Sign in for a linked smart wallet.');
  const response = await fetch(`${TESTNET_HORIZON}/accounts/${encodeURIComponent(address)}`, { signal });
  if (!response.ok) throw new Error(response.status === 404 ? 'Account is not funded on Testnet.' : 'Could not load Testnet balance.');
  const data: { balances?: Array<{ asset_type: string; balance: string }> } = await response.json();
  const balance = data.balances?.find(b => b.asset_type === 'native')?.balance;
  if (typeof balance !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(balance)) throw new Error('Invalid Testnet balance response.');
  return balance;
}

