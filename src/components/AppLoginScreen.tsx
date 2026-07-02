import Login from './Login';

interface AppLoginScreenProps {
  onLoginSuccess: (session: unknown) => void;
}

/** Full-screen sign-in for APK — no website landing or demo extras. */
export default function AppLoginScreen({ onLoginSuccess }: AppLoginScreenProps) {
  return (
    <Login
      onLoginSuccess={onLoginSuccess}
      showDemoShortcuts={false}
      appMode
    />
  );
}
