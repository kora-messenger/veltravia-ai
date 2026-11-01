import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './components/ui';
import {
  DashboardPage,
  IntegrationsPage,
  FilesPage,
  AudioPage,
  ImagePage,
  DocumentsPage,
  ConnectionsPage,
  IntelligencePage,
  ReasoningPage,
  VideoPage,
  ProjectDetailPage,
  ProjectWorkspacePage,
  ProjectsPage,
  AiProvidersPage,
  ModelRoutingPage,
  BuilderPage,
  FrontendBuilderPage,
  BackendBuilderPage,
  ExecutePage,
  SettingsPage,
} from './pages';

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
              case 'integrations':
                return <IntegrationsPage />;
              case 'files':
                return <FilesPage />;
              case 'audio':
                return <AudioPage />;
              case 'video':
                return <VideoPage />;
              case 'image':
                return <ImagePage />;
              case 'documents':
                return <DocumentsPage />;
              case 'connections':
                return <ConnectionsPage />;
              case 'intelligence':
                return <IntelligencePage />;
              case 'project-detail':
                return <ProjectDetailPage projectId={route.projectId} />;
              case 'project-workspace':
                return <ProjectWorkspacePage projectId={route.projectId} />;
              case 'project-builder':
                return <FrontendBuilderPage projectId={route.projectId} />;
              case 'project-backend':
                return <BackendBuilderPage projectId={route.projectId} />;
              case 'reasoning':
                return <ReasoningPage />;
              case 'ai-providers':
                return <AiProvidersPage />;
              case 'builder':
                return <BuilderPage />;
              case 'model-routing':
                return <ModelRoutingPage />;
              case 'execute':
                return <ExecutePage />;
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
