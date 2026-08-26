import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Smartphone, Bot, Image, MessageSquare, MessageCircleReply,
  Users, Settings, FileText, LogOut, Languages, Clock, Filter, Megaphone, KeyRound, Package, HardDrive, Share2, BadgeCheck,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { useAuth, type UserRole } from '../../store/auth';
import clsx from 'clsx';

// Which items an operator can see. Anything not in this list is hidden from
// operators (owners + admins always see everything). Guard is client-side only;
// deep-linking to a hidden route still loads the page (documented in the plan).
const OPERATOR_ALLOWED = new Set([
  '/', '/inbox', '/saved-replies', '/customers', '/segments',
  '/follow-ups', '/retargeting',
]);

export function Sidebar() {
  const { t, lang, setLang } = useI18n();
  const logout = useAuth((s) => s.logout);
  const role: UserRole = useAuth((s) => s.user?.role ?? 'owner');
  const nav = useNavigate();

  const allItems = [
    { to: '/', icon: LayoutDashboard, label: t.nav.dashboard, end: true },
    { to: '/accounts', icon: Smartphone, label: t.nav.accounts },
    { to: '/wa-cloud', icon: BadgeCheck, label: t.waCloud.title },
    { to: '/bots', icon: Bot, label: t.nav.bots },
    { to: '/media', icon: Image, label: t.nav.media },
    { to: '/inbox', icon: MessageSquare, label: t.nav.inbox },
    { to: '/saved-replies', icon: MessageCircleReply, label: t.savedReplies.title },
    { to: '/customers', icon: Users, label: t.customers.title },
    { to: '/segments', icon: Filter, label: t.segments.title },
    { to: '/follow-ups', icon: Clock, label: t.followups.title },
    { to: '/retargeting', icon: Megaphone, label: t.campaigns.title },
    { to: '/products', icon: Package, label: t.products.title },
    { to: '/social', icon: Share2, label: t.social.title },
    { to: '/ai-keys', icon: KeyRound, label: t.aiKeys.title },
    { to: '/storage', icon: HardDrive, label: t.storage.title },
    { to: '/settings', icon: Settings, label: t.nav.settings },
    { to: '/logs', icon: FileText, label: t.nav.logs },
  ];
  const items = role === 'operator'
    ? allItems.filter((it) => OPERATOR_ALLOWED.has(it.to))
    : allItems;

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-l border-r-0 border-gray-200 bg-white" style={{ borderInlineEnd: '1px solid #e5e7eb', borderInlineStart: 'none' }}>
      <div className="flex h-14 items-center gap-2 border-b border-gray-100 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 font-bold text-white">B</div>
        <span className="font-bold">{t.app.brand}</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                isActive ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-50'
              )
            }
          >
            <it.icon size={18} />
            <span>{it.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-gray-100 p-2 space-y-1">
        <button
          onClick={() => setLang(lang === 'ar' ? 'fr' : 'ar')}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          <Languages size={18} />
          <span>{lang === 'ar' ? 'Français' : 'العربية'}</span>
        </button>
        <button
          onClick={async () => { await logout(); nav('/login'); }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
        >
          <LogOut size={18} />
          <span>{t.app.logout}</span>
        </button>
      </div>
    </aside>
  );
}
