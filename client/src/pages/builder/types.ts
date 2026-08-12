export type BlockType = 'text' | 'audio' | 'image' | 'video' | 'document' | 'delay' | 'options' | 'action';
export type StepType = 'welcome' | 'keyword' | 'exact_match' | 'option_reply' | 'fallback' | 'handover' | 'order' | 'normal' | 'end';
export type DisplayMode = 'numbered' | 'buttons' | 'list' | 'poll' | 'auto';

export interface MediaFile {
  id: string; name: string; type: string; mimeType: string; sizeBytes: number;
}

export interface MessageBlock {
  id: string;
  stepId: string;
  type: BlockType;
  content: string | null;
  mediaId: string | null;
  caption: string | null;
  delaySeconds: number | null;
  actionType: string | null;
  actionPayload: string | null;
  enabled: boolean;
  sortOrder: number;
  metadata: string | null;
  media: MediaFile | null;
}

export interface BotOption {
  id: string;
  stepId: string;
  label: string;
  number: string;
  keywords: string | null;
  targetStepId: string | null;
  description: string | null;
  enabled: boolean;
  sortOrder: number;
  displayMode: DisplayMode;
}

export interface BotStep {
  id: string;
  botId: string;
  title: string;
  description: string | null;
  type: StepType;
  triggerType: string;
  triggerValue: string | null;
  isActive: boolean;
  sortOrder: number;
  settings: string | null;
  blocks: MessageBlock[];
  options: BotOption[];
}

export interface Bot {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused';
  defaultLanguage: string;
  isActive: boolean;
  priority: number;
  accounts: { account: { id: string; name: string; status: string } }[];
  settings: BotSettings | null;
  steps: BotStep[];
}

export interface BotSettings {
  botId: string;
  welcomeEnabled: boolean;
  fallbackEnabled: boolean;
  groupsEnabled: boolean;
  workingHours: string | null;
  defaultFallbackMessage: string | null;
  humanHandoverKeywords: string | null;
  inactivityResetHours: number;
  sendWelcomeOnce: boolean;
  pauseAfterWelcome: boolean;
  notifyOnHandover: boolean;
  maxFailedAttempts: number;
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'suggestion';
  code: string;
  message: string;
  stepId?: string;
  blockId?: string;
  optionId?: string;
}
export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  suggestions: ValidationIssue[];
}
