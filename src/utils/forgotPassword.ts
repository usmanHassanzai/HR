import { callEdgeFunction } from './edgeFunctionClient';

/** Request a new temporary password emailed to a registered Scorr account. */
export async function requestForgotPassword(email: string): Promise<void> {
  const address = email.trim();
  if (!address) throw new Error('Enter your registered email address.');
  const data = await callEdgeFunction<{ sent?: boolean; error?: string }>('forgot_password', {
    email: address,
  });
  if (data?.error) throw new Error(data.error);
}
