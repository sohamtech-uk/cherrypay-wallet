export async function sendVerificationEmail(_email: string, _code: string): Promise<void> {
  throw new Error('EMAIL_DELIVERY_NOT_CONFIGURED');
}
