import Login from './Login';

interface AppLoginScreenProps {
  onLoginSuccess: (session: unknown) => void;
}

/** Full-screen sign-in for APK — demo accounts + no website landing. */
export default function AppLoginScreen({ onLoginSuccess }: AppLoginScreenProps) {
  return (
    <Login
      onLoginSuccess={onLoginSuccess}
      showDemoShortcuts
      appMode
      demoSectionLabel="Demo accounts"
    />
  );
}
