/** Generic credential error — do not reveal whether the email is registered. */
export function loginFailureMessage(authMessage: string): string {
  const m = (authMessage || '').toLowerCase();
  if (
    m.includes('invalid login') ||
    m.includes('invalid credentials') ||
    m.includes('invalid email or password') ||
    m.includes('email or password') ||
    m.includes('invalid_grant')
  ) {
    return 'Incorrect email or password.';
  }
  return authMessage || 'Could not sign in.';
}
