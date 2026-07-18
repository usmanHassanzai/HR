import Login from './Login';

interface AppLoginScreenProps {
  onLoginSuccess: (session: unknown) => void;
}

/** Full-screen sign-in for APK — demo accounts + company registration. */
export default function AppLoginScreen({ onLoginSuccess }: AppLoginScreenProps) {
  return (
    <Login
      onLoginSuccess={onLoginSuccess}
      showDemoShortcuts
      enableCompanyRegister
      appMode
      demoSectionLabel="3-day demo sandbox"
    />
  );
}
