/**
 * Variable substitution. Supports:
 *   {{contact.name}}    {{contact.phone}}
 *   {{bot.name}}        {{account.name}}
 *   {{order.fullName}}  {{order.phone}}  {{order.city}}
 *   {{order.address}}   {{order.quantity}}  {{order.notes}}
 */
import { phoneFromJid } from '../lib/jid.js';

export interface SubstitutionContext {
  contact?: { name?: string | null; jid?: string };
  bot?: { name?: string };
  account?: { name?: string };
  order?: Record<string, string | undefined>;
}

export function substitute(text: string, ctx: SubstitutionContext): string {
  if (!text) return text;
  return text.replace(/\{\{([\w.]+)\}\}/g, (_m, path) => {
    const parts = path.split('.');
    if (parts[0] === 'contact' && parts[1] === 'name') return ctx.contact?.name ?? '';
    if (parts[0] === 'contact' && parts[1] === 'phone')
      return ctx.contact?.jid ? phoneFromJid(ctx.contact.jid) : '';
    if (parts[0] === 'bot' && parts[1] === 'name') return ctx.bot?.name ?? '';
    if (parts[0] === 'account' && parts[1] === 'name') return ctx.account?.name ?? '';
    if (parts[0] === 'order' && parts[1]) return ctx.order?.[parts[1]] ?? '';
    return '';
  });
}
