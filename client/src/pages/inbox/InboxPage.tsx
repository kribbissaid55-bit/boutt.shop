import { useEffect, useState, useCallback } from 'react';
import { Search, MoreVertical } from 'lucide-react';
import { api } from '../../api/client';
import { events } from '../../api/sse';
import { useI18n } from '../../i18n';
import { ConversationList } from './ConversationList';
import { ChatThread } from './ChatThread';
import { CustomerProfile } from './CustomerProfile';
import { MessageComposer } from './MessageComposer';
import { Empty } from '../../components/ui/Empty';
import type { ChatMessage, ContactDetail } from './types';

const phoneFromJid = (jid: string) => {
  const at = jid.indexOf('@');
  const head = at === -1 ? jid : jid.slice(0, at);
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(0, colon);
};

type ConversationPage = { contact: ContactDetail; messages: ChatMessage[]; hasMore: boolean };
type OlderPage = { messages: ChatMessage[]; hasMore: boolean };

export function InboxPage() {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadInitial = useCallback(async (id: string) => {
    const data = await api.get<ConversationPage>(`/inbox/conversations/${id}?take=30`);
    setContact({ ...data.contact, tags: data.contact.tags ?? [] });
    setMessages(data.messages);
    setHasMore(!!data.hasMore);
  }, []);

  const loadOlder = useCallback(async () => {
    if (!selectedId || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      // Snapshot the current messages so we page from the oldest we have.
      const oldestIso = messages[0]?.createdAt;
      if (!oldestIso) return;
      const data = await api.get<OlderPage>(
        `/inbox/conversations/${selectedId}?take=30&before=${encodeURIComponent(oldestIso)}`
      );
      setMessages((cur) => [...data.messages, ...cur]);
      setHasMore(!!data.hasMore);
    } finally { setLoadingOlder(false); }
  }, [selectedId, messages, loadingOlder, hasMore]);

  useEffect(() => {
    if (!selectedId) { setContact(null); setMessages([]); setHasMore(false); return; }
    loadInitial(selectedId).catch(() => {});
  }, [selectedId, loadInitial, refreshKey]);

  // Live updates via SSE
  useEffect(() => {
    return events.on((e) => {
      if (e.type === 'message.in' || e.type === 'message.out') {
        setRefreshKey((k) => k + 1);
        if (selectedId && (e as any).contactId === selectedId) {
          loadInitial(selectedId).catch(() => {});
        }
      }
    });
  }, [selectedId, loadInitial]);

  return (
    <div className="-m-6 grid h-[100dvh] grid-cols-[320px_1fr_320px]">
      <ConversationList
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        refreshKey={refreshKey}
      />

      <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[#efeae2]">
        {!contact ? (
          <div className="flex h-full items-center justify-center">
            <Empty icon={<Search size={36} />} title={t.inbox.selectContact} />
          </div>
        ) : (
          <>
            {/* Chat header — clean white, WhatsApp Web style */}
            <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-200 text-sm font-bold text-brand-700">
                {(contact.name ?? phoneFromJid(contact.jid)).slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate text-[15px] font-semibold text-gray-900">{contact.name ?? phoneFromJid(contact.jid)}</div>
                <div className="flex items-center gap-1.5 text-[11px] text-gray-500" dir="ltr">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    WhatsApp
                  </span>
                  <span>+{phoneFromJid(contact.jid)}</span>
                </div>
              </div>
              <button className="rounded-full p-1.5 text-gray-500 hover:bg-gray-100" title="More">
                <MoreVertical size={18} />
              </button>
            </div>

            <ChatThread
              messages={messages}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
            />

            <MessageComposer
              contactId={contact.id}
              onSent={() => loadInitial(contact.id)}
            />
          </>
        )}
      </main>

      {contact ? (
        <CustomerProfile contact={contact} onChanged={() => loadInitial(contact.id)} />
      ) : (
        <aside className="hidden border-s border-gray-200 bg-white lg:block" />
      )}
    </div>
  );
}
