import { createContext, useContext } from 'react';
import type { PaymentAdapter } from './model';
export const PaymentContext = createContext<PaymentAdapter | null>(null);
export const usePayments = () => useContext(PaymentContext);
