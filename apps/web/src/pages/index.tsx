import { Card, EmptyState } from '../components/ui';

export function DashboardPage() {
  return (
    <Card title="Dashboard" description="Your platform overview will appear here.">
      <EmptyState
        title="Nothing to show yet"
        description="The dashboard is a planned step. The platform foundation is being built first."
      />
    </Card>
  );
}

export function ProjectsPage() {
  return (
    <Card title="Projects" description="Projects you create with Veltravia AI will be listed here.">
      <EmptyState
        title="No projects yet"
        description="Project creation arrives in a later step. The project engine behind it is already built."
      />
    </Card>
  );
}

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
