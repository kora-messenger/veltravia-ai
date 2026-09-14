import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './components/ui';
import { DashboardPage, ProjectDetailPage, ProjectsPage, SettingsPage } from './pages';

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppShell
          renderPage={(route) => {
            switch (route.id) {
              case 'dashboard':
                return <DashboardPage />;
              case 'projects':
                return <ProjectsPage />;
              case 'project-detail':
                return <ProjectDetailPage projectId={route.projectId} />;
              case 'settings':
                return <SettingsPage />;
              default:
                return <DashboardPage />;
            }
          }}
        />
      </ToastProvider>
    </ThemeProvider>
  );
}
