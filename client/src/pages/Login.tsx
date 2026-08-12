import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { useI18n } from '../i18n';
import { Button } from '../components/ui/Button';
import { Input, Field } from '../components/ui/Input';
import { Languages } from 'lucide-react';

export function LoginPage() {
  const { t, lang, setLang } = useI18n();
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      nav('/');
    } catch (err: any) {
      const code = err?.data?.error ?? err?.message;
      if (code === 'account_disabled') setError(t.login.accountDisabled);
      else if (code === 'too_many_attempts') setError(t.login.tooManyAttempts);
      else setError(t.login.invalid);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-white p-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white">B</div>
            <span className="text-lg font-bold">{t.app.brand}</span>
          </div>
          <button
            onClick={() => setLang(lang === 'ar' ? 'fr' : 'ar')}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
          >
            <Languages size={14} />
            {lang === 'ar' ? 'FR' : 'AR'}
          </button>
        </div>
        <h1 className="mb-1 text-xl font-bold">{t.login.title}</h1>
        <p className="mb-4 text-sm text-gray-500">{t.login.welcome}</p>
        <form onSubmit={submit} className="space-y-3">
          <Field label={t.login.username} required>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </Field>
          <Field label={t.login.password} required>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">{t.login.submit}</Button>
        </form>
      </div>
    </div>
  );
}
