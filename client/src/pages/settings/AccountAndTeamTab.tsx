import { useEffect, useState } from 'react';
import { KeyRound, UserPlus, Trash2, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useAuth, type UserRole } from '../../store/auth';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Field } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';

type AdminUserRow = {
  id: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  email: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  createdById: string | null;
};

// Human-readable mapping for server error codes coming from admin/auth routes.
function translateError(e: any, t: any): string {
  const code = e?.data?.error ?? e?.message;
  const map = t.settings.account.errors;
  switch (code) {
    case 'username_taken': return map.usernameTaken;
    case 'last_owner': return map.lastOwner;
    case 'cannot_change_own_role': return map.cannotChangeOwnRole;
    case 'cannot_deactivate_self': return map.cannotDeactivateSelf;
    case 'cannot_delete_self': return map.cannotDeleteSelf;
    case 'admin_can_only_manage_operators': return map.adminOnlyOperators;
    case 'admin_can_only_create_operators': return map.adminOnlyOperators;
    case 'wrong_current_password': return t.settings.account.wrongCurrent;
    case 'too_many_attempts': return t.login.tooManyAttempts;
    default: return t.app.error;
  }
}

function PasswordCard() {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (next.length < 8) return toast.error(t.settings.account.passwordTooShort);
    if (next !== confirm) return toast.error(t.settings.account.passwordMismatch);
    setSaving(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success(t.settings.account.passwordChanged);
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e: any) {
      toast.error(translateError(e, t));
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader>{t.settings.account.passwordTitle}</CardHeader>
      <CardBody>
        <form onSubmit={submit} className="max-w-md">
          <fieldset disabled={saving} className="space-y-3">
            <p className="text-xs text-gray-500">{t.settings.account.passwordHint}</p>
            <Field label={t.settings.account.currentPassword}>
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </Field>
            <Field label={t.settings.account.newPassword} hint={t.settings.account.passwordAtLeast8}>
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required />
            </Field>
            <Field label={t.settings.account.confirmPassword}>
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
            </Field>
            <div className="pt-1">
              <Button type="submit" loading={saving}>
                <KeyRound size={16} /> {t.settings.account.changePassword}
              </Button>
            </div>
          </fieldset>
        </form>
      </CardBody>
    </Card>
  );
}

function AddMemberModal({ open, onClose, onCreated, currentRole }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  currentRole: UserRole;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Admins can only create operators. Owners default to 'operator' but can escalate.
  const initialRole: UserRole = currentRole === 'admin' ? 'operator' : 'operator';
  const [role, setRole] = useState<UserRole>(initialRole);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setUsername(''); setEmail(''); setPassword(''); setRole(initialRole);
    }
  }, [open, initialRole]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (password.length < 8) return toast.error(t.settings.account.passwordTooShort);
    setSaving(true);
    try {
      await api.post('/admin/users', {
        username: username.trim(),
        password,
        role,
        email: email.trim() || null,
      });
      toast.success(t.settings.account.memberAdded);
      onCreated();
      onClose();
    } catch (e: any) {
      toast.error(translateError(e, t));
    } finally { setSaving(false); }
  };

  const roleOptions: UserRole[] = currentRole === 'owner'
    ? ['owner', 'admin', 'operator']
    : ['operator'];

  return (
    <Modal open={open} onClose={onClose} title={t.settings.account.addMemberTitle}>
      <form onSubmit={submit}>
        <fieldset disabled={saving} className="space-y-3">
          <Field label={t.settings.account.username} hint={t.settings.account.usernameHint}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
          </Field>
          <Field label={t.settings.account.email}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t.settings.account.password} hint={t.settings.account.passwordAtLeast8}>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </Field>
          <Field label={t.settings.account.role} hint={t.settings.account.roleHint[role]}>
            <select
              className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>{t.settings.account.roles[r]}</option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
            <Button type="submit" loading={saving}>
              <UserPlus size={16} /> {t.app.add}
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: {
  user: AdminUserRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [pwd, setPwd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (user) setPwd(''); }, [user]);
  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (pwd.length < 8) return toast.error(t.settings.account.passwordTooShort);
    setSaving(true);
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { newPassword: pwd });
      toast.success(t.settings.account.resetDone);
      onDone();
      onClose();
    } catch (e: any) {
      toast.error(translateError(e, t));
    } finally { setSaving(false); }
  };

  return (
    <Modal open={!!user} onClose={onClose} title={t.settings.account.resetPasswordTitle}>
      <form onSubmit={submit}>
        <fieldset disabled={saving} className="space-y-3">
          <p className="text-xs text-gray-500">{t.settings.account.resetPasswordHint}</p>
          <Field label={`${t.settings.account.newPasswordFor} ${user.username}`} hint={t.settings.account.passwordAtLeast8}>
            <Input type="password" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required minLength={8} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
            <Button type="submit" loading={saving}><RotateCcw size={16} /> {t.settings.account.resetPassword}</Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function TeamCard() {
  const { t } = useI18n();
  const me = useAuth((s) => s.user);
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserRow | null>(null);

  const load = () => {
    api.get<AdminUserRow[]>('/admin/users').then(setRows).catch((e: any) => {
      toast.error(e?.message ?? t.app.error);
      setRows([]);
    });
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const patch = async (u: AdminUserRow, body: Partial<Pick<AdminUserRow, 'role' | 'isActive' | 'email'>>) => {
    try {
      const updated = await api.patch<AdminUserRow>(`/admin/users/${u.id}`, body);
      setRows((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? null);
      toast.success(t.settings.account.memberUpdated);
    } catch (e: any) {
      toast.error(translateError(e, t));
    }
  };

  const remove = async (u: AdminUserRow) => {
    if (!confirm(t.settings.account.confirmDelete)) return;
    try {
      await api.delete(`/admin/users/${u.id}`);
      setRows((prev) => prev?.filter((r) => r.id !== u.id) ?? null);
      toast.success(t.settings.account.memberDeleted);
    } catch (e: any) {
      toast.error(translateError(e, t));
    }
  };

  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return null;

  const roleOptionsFor = (u: AdminUserRow): UserRole[] => {
    if (me.role === 'owner') return ['owner', 'admin', 'operator'];
    if (u.role === 'operator') return ['operator'];
    return [u.role];
  };

  const roleBadgeCls: Record<UserRole, string> = {
    owner: 'bg-purple-50 text-purple-700 border-purple-200',
    admin: 'bg-blue-50 text-blue-700 border-blue-200',
    operator: 'bg-gray-50 text-gray-600 border-gray-200',
  };

  return (
    <>
      <Card>
        <CardHeader
          actions={
            <Button size="sm" onClick={() => setAdding(true)}>
              <UserPlus size={14} /> {t.settings.account.addMember}
            </Button>
          }
        >
          {t.settings.account.teamTitle}
        </CardHeader>
        <CardBody>
          <p className="mb-3 text-xs text-gray-500">{t.settings.account.teamHint}</p>
          {rows == null ? (
            <div className="text-gray-400 text-sm">{t.app.loading}</div>
          ) : rows.length === 0 ? (
            <div className="text-gray-400 text-sm">{t.app.empty}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs uppercase text-gray-500 border-b border-gray-100">
                    <th className="px-3 py-2 text-start">{t.settings.account.username}</th>
                    <th className="px-3 py-2 text-start">{t.settings.account.email}</th>
                    <th className="px-3 py-2 text-start">{t.settings.account.role}</th>
                    <th className="px-3 py-2 text-start">{t.settings.account.status}</th>
                    <th className="px-3 py-2 text-start">{t.settings.account.lastLogin}</th>
                    <th className="px-3 py-2 text-end">{t.app.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((u) => {
                    const isMe = u.id === me.id;
                    const canManage = me.role === 'owner' || u.role === 'operator';
                    return (
                      <tr key={u.id}>
                        <td className="px-3 py-2 font-medium text-gray-800">
                          {u.username}
                          {isMe && <span className="ms-2 text-xs text-brand-600">({t.settings.account.roles[me.role]})</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{u.email ?? '—'}</td>
                        <td className="px-3 py-2">
                          {canManage && !isMe ? (
                            <select
                              className={`rounded-md border px-2 py-1 text-xs font-medium ${roleBadgeCls[u.role]}`}
                              value={u.role}
                              onChange={(e) => patch(u, { role: e.target.value as UserRole })}
                            >
                              {roleOptionsFor(u).map((r) => (
                                <option key={r} value={r}>{t.settings.account.roles[r]}</option>
                              ))}
                            </select>
                          ) : (
                            <span className={`inline-block rounded-md border px-2 py-1 text-xs font-medium ${roleBadgeCls[u.role]}`}>
                              {t.settings.account.roles[u.role]}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={u.isActive}
                              disabled={!canManage || isMe}
                              onChange={(e) => patch(u, { isActive: e.target.checked })}
                              className="peer sr-only"
                            />
                            <span className="relative inline-block h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-brand-500 transition">
                              <span className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 transition" />
                            </span>
                            <span className="text-xs text-gray-600">
                              {u.isActive ? t.settings.account.active : t.settings.account.inactive}
                            </span>
                          </label>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : t.settings.account.never}
                        </td>
                        <td className="px-3 py-2 text-end">
                          <div className="inline-flex items-center gap-1">
                            {canManage && (
                              <Button size="sm" variant="ghost" onClick={() => setResetTarget(u)} title={t.settings.account.resetPassword}>
                                <RotateCcw size={14} />
                              </Button>
                            )}
                            {canManage && !isMe && (
                              <Button size="sm" variant="ghost" onClick={() => remove(u)} title={t.app.delete} className="text-red-500 hover:bg-red-50">
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <AddMemberModal
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={load}
        currentRole={me.role}
      />
      <ResetPasswordModal
        user={resetTarget}
        onClose={() => setResetTarget(null)}
        onDone={load}
      />
    </>
  );
}

export function AccountAndTeamTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PasswordCard />
      <TeamCard />
    </div>
  );
}
