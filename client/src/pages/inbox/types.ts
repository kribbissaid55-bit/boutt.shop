export type CustomerStatusKey = 'sent_no_reply' | 'replied' | 'ordered';

export interface ConversationSummary {
  id: string;
  jid: string;
  name: string | null;
  status: string;
  /** Derived "sent / replied / ordered" tag — drives the colored chip. */
  derivedStatus: CustomerStatusKey | null;
  botPaused: boolean;
  doNotContact: boolean;
  tags: string[];
  source: string | null;
  city: string | null;
  unread: number;
  lastMessageBody: string | null;
  lastMessageType: string;
  lastMessageDirection: 'in' | 'out' | null;
  lastMessageAt: string | null;
  account: { id: string; name: string };
}

export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  type: string;       // text | audio | image | video | document
  body: string | null;
  mediaId: string | null;
  status: string;
  senderType: string | null;  // 'customer' | 'bot' | 'admin' | 'campaign' | 'follow_up'
  stepId: string | null;
  createdAt: string;
}

export interface ContactDetail {
  id: string;
  accountId: string;
  jid: string;
  name: string | null;
  city: string | null;
  address: string | null;
  status: string;
  botPaused: boolean;
  doNotContact: boolean;
  tags: string[];
  source: string | null;
  campaignName: string | null;
  notes: string | null;
  firstMessageAt: string | null;
  lastIncomingMessageAt: string | null;
  lastOutgoingMessageAt: string | null;
  lastInteractionAt: string | null;
  currentStepId: string | null;
  account: { id: string; name: string; status: string; phoneNumber: string | null };
  notesList: { id: string; body: string; createdAt: string }[];
  orders: { id: string; status: string; quantity: string | null; fullName: string | null; createdAt: string }[];
  /** Operator visibility — replies sent to this customer in the trailing 24h.
   * cap = the configured daily-per-customer reply cap (0 = disabled). */
  repliesLast24h?: { count: number; cap: number; resetsAt: string | null };
}
