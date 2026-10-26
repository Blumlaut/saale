import { SettingsShell } from "./components/settings-shell";

// Each section keeps its own state; the shell only holds the settings load and
// the phone section picker, so moving between sections does not remount it.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
