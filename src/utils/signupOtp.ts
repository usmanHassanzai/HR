import { callEdgeFunction } from './edgeFunctionClient';

export async function sendSignupOtp(email: string): Promise<void> {
  const data = await callEdgeFunction<{ sent?: boolean; error?: string }>('signup_otp', {
    action: 'send',
    email: email.trim(),
  });
  if (data?.error) throw new Error(data.error);
}

export async function verifySignupOtp(email: string, code: string): Promise<void> {
  const data = await callEdgeFunction<{ ok?: boolean; error?: string }>('signup_otp', {
    action: 'verify',
    email: email.trim(),
    code: code.trim(),
  });
  if (data?.error) throw new Error(data.error);
  if (!data?.ok) throw new Error('Could not verify that code.');
}
