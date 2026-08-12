import { create } from 'zustand';
import { ar } from './ar';
import { fr } from './fr';

type Lang = 'ar' | 'fr';
const dict: Record<Lang, typeof ar> = { ar, fr };

type Store = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: typeof ar;
};

const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('lang')) as Lang | null;
const initial: Lang = stored === 'fr' || stored === 'ar' ? stored : 'ar';

const applyDir = (l: Lang) => {
  const html = document.documentElement;
  html.setAttribute('lang', l);
  html.setAttribute('dir', l === 'ar' ? 'rtl' : 'ltr');
};

if (typeof document !== 'undefined') applyDir(initial);

export const useI18n = create<Store>((set) => ({
  lang: initial,
  t: dict[initial],
  setLang: (l) => {
    localStorage.setItem('lang', l);
    applyDir(l);
    set({ lang: l, t: dict[l] });
  },
}));

export const t = () => useI18n.getState().t;
