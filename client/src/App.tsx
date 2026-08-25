import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import { useAuth } from './store/auth';
import { t as getT } from './i18n';
import { Layout } from './components/layout/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AccountsPage } from './pages/Accounts';
import { AccountDetailPage } from './pages/AccountDetail';
import { BotsPage } from './pages/Bots';
import { BotBuilderPage } from './pages/builder/BotBuilderPage';
import { MediaPage } from './pages/Media';
import { InboxPage } from './pages/inbox/InboxPage';
import { SavedRepliesPage } from './pages/savedReplies/SavedRepliesPage';
import { CustomersPage } from './pages/customers/CustomersPage';
import { ImportCustomersPage } from './pages/customers/ImportCustomersPage';
import { FollowUpsPage } from './pages/followups/FollowUpsPage';
import { SegmentsPage } from './pages/segments/SegmentsPage';
import { CampaignsPage } from './pages/retargeting/CampaignsPage';
import { SettingsPage } from './pages/Settings';
import { LogsPage } from './pages/Logs';
import { AiKeysPage } from './pages/ai/AiKeysPage';
import { ProductsPage } from './pages/products/ProductsPage';
import { StoragePage } from './pages/storage/StoragePage';
import { SocialPage } from './pages/social/SocialPage';

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
    const onUnauth = () => {
      const wasLoggedIn = useAuth.getState().user != null;
      useAuth.setState({ user: null, loading: false });
      if (location.pathname !== '/login') {
        if (wasLoggedIn) {
          try { toast.error(getT().login.sessionExpired); } catch {}
        }
        location.href = '/login';
      }
    };
    // Safety net — surface unhandled promise rejections as toasts so silent
    // API failures don't leave the operator staring at an unchanged page.
    // Auth-401 is handled separately above; other errors get a red toast.
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      const err: any = ev.reason;
      if (err?.status === 401) return; // handled by auth:unauthorized
      const msg = err?.message ?? String(err ?? 'Unexpected error');
      // eslint-disable-next-line no-console
      console.error('[unhandledrejection]', err);
      toast.error(msg.slice(0, 200));
    };
    window.addEventListener('auth:unauthorized', onUnauth);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('auth:unauthorized', onUnauth);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, [bootstrap]);

  return (
    <BrowserRouter>
      <Toaster position="top-center" />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/bots/:id" element={<BotBuilderPage />} />
          <Route path="/media" element={<MediaPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/saved-replies" element={<SavedRepliesPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/import" element={<ImportCustomersPage />} />
          <Route path="/contacts" element={<CustomersPage />} />
          <Route path="/segments" element={<SegmentsPage />} />
          <Route path="/follow-ups" element={<FollowUpsPage />} />
          <Route path="/retargeting" element={<CampaignsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/ai-keys" element={<AiKeysPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/social" element={<SocialPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/logs" element={<LogsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
