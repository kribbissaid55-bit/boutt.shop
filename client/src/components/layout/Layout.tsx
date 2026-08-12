import { Outlet, Navigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useAuth } from '../../store/auth';
import { useEffect } from 'react';
import { events } from '../../api/sse';

export function Layout() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (user) events.start();
  }, [user]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-gray-400">...</div>;
  }
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-7xl p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
