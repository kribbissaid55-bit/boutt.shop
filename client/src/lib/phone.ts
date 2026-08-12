export const phoneFromJid = (jid: string): string => {
  const at = jid.indexOf('@');
  const head = at === -1 ? jid : jid.slice(0, at);
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(0, colon);
};
