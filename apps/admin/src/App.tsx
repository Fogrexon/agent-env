import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/Layout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { JobsPage } from './pages/JobsPage.js';
import { QueuePage } from './pages/QueuePage.js';
import { RunDetailPage } from './pages/RunDetailPage.js';
import { SchedulesPage } from './pages/SchedulesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AdminThemeProvider } from './ui/theme.js';

export function App() {
  return (
    <AdminThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="jobs/:agentId" element={<JobsPage />} />
            <Route path="queue" element={<QueuePage />} />
            <Route path="runs/:runId" element={<RunDetailPage />} />
            <Route path="schedules" element={<SchedulesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AdminThemeProvider>
  );
}
