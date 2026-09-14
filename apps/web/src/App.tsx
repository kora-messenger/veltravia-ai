import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './components/ui';
import { DashboardPage, ProjectsPage, SettingsPage } from './pages';

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppShell
          renderPage={(routeId) => {
            switch (routeId) {
              case 'dashboard':
                return <DashboardPage />;
              case 'projects':
                return <ProjectsPage />;
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
