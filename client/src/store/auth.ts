import { create } from 'zustand';
import { api } from '../api/client';

export type UserRole = 'owner' | 'admin' | 'operator';
type User = { id: string; username: string; role: UserRole };
type Store = {
  user: User | null;
  loading: boolean;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

// Legacy sessions issued before roles existed default to 'owner' — matches the
// server's fallback in requireAuth so behaviour stays consistent on version bumps.
function normalize(u: any): User {
  return { id: u.id, username: u.username, role: (u.role as UserRole) ?? 'owner' };
}

export const useAuth = create<Store>((set) => ({
  user: null,
  loading: true,
  async bootstrap() {
    try {
      const me = await api.get<User>('/auth/me');
      set({ user: normalize(me), loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },
  async login(username, password) {
    const me = await api.post<User>('/auth/login', { username, password });
    set({ user: normalize(me) });
  },
  async logout() {
    await api.post('/auth/logout');
    set({ user: null });
  },
}));
