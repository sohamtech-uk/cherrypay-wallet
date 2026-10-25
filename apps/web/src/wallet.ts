export const NETWORK = 'TESTNET' as const;
export const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
export type WalletSnapshot = { address: string; balance: string; loading: boolean; error?: string };
export function validateClassicAddress(address: string): boolean { return /^G[A-Z2-7]{55}$/.test(address); }
export function validateContractAddress(address: string): boolean { return /^C[A-Z2-7]{55}$/.test(address); }
export function isSupportedWalletAddress(address: string): boolean { return validateClassicAddress(address) || validateContractAddress(address); }
export async function loadBalance(address: string, signal?: AbortSignal): Promise<string> {
  if (!validateClassicAddress(address)) throw new Error('A Stellar smart-account balance adapter is not connected yet.');
  const response = await fetch(`${TESTNET_HORIZON}/accounts/${encodeURIComponent(address)}`, { signal });
  if (!response.ok) throw new Error(response.status === 404 ? 'Account is not funded on Testnet.' : 'Could not load Testnet balance.');
  const data: { balances?: Array<{ asset_type: string; balance: string }> } = await response.json();
  return data.balances?.find(b => b.asset_type === 'native')?.balance ?? '0';
}
