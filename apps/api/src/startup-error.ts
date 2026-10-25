import { PaymentError } from './payments/model.js';
/** Only application-owned diagnostics are printable. SDK/DB errors may contain secrets. */
export function startupErrorCode(error: unknown, fallback: string): string {
  if (error instanceof PaymentError) return error.code;
  if (error instanceof Error && ['INVALID_MANIFEST_JSON','INVALID_RELAYER_SECRET','KNOWN_UNSAFE_ACCOUNT_WASM'].includes(error.message)) return error.message;
  return fallback;
}
