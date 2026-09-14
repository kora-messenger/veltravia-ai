import { Card, EmptyState } from '../components/ui';

/**
 * Settings placeholder. A full settings surface (account, preferences,
 * integrations) arrives in a later checkpoint; the theme preference in the
 * account menu is the only user setting wired so far.
 */
export function SettingsPage() {
  return (
    <Card title="Settings" description="Platform settings will live here.">
      <EmptyState
        title="Settings coming later"
        description="A full settings surface arrives in a later step. Your theme choice in the account menu already applies."
      />
    </Card>
  );
}
