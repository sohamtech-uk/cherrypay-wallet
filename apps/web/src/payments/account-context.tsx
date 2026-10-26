import { createContext, useContext } from 'react';
import type { OwnedWallet } from './api';
import type { DeploymentView } from './deployment';

/** Session state is held in memory by PaymentConnection; no access tokens enter React context. */
export interface WalletAccount {
  accountId: string;
  authenticated: boolean;
  connected: boolean;
  credentialCount: number;
  emailVerified?: boolean;
  emailPaymentsEnabled?: boolean;
  requestEmailVerification?(): Promise<void>;
  confirmEmailVerification?(code: string): Promise<void>;
  setEmailPaymentsEnabled?(enabled: boolean): Promise<void>;
  canSign: boolean;
  busy: boolean;
  error: string;
  notice: string;
  deployment: DeploymentView | null;
  deploymentStatus: string;
  wallets: OwnedWallet[];
  addPasskey(): Promise<void>;
  refreshDeployment(): Promise<void>;
  fundTestnet(): Promise<void>;
  signOut(): Promise<void>;
}
export const WalletAccountContext = createContext<WalletAccount | null>(null);
export const useWalletAccount = () => useContext(WalletAccountContext);
