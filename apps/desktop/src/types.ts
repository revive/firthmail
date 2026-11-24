/** Shapes of the flectar-mail-core models as they cross the Tauri bridge
 * (the engine serializes with camelCase names). */

export interface EngineAddress {
  name?: string | null;
  /** The engine's `Address` serializes its address field as `email`. */
  email: string;
}

export interface EngineAccount {
  id: number;
  email: string;
  displayName?: string | null;
  name?: string | null;
  syncState: string;
  syncError?: string | null;
}

export interface EngineFolder {
  id: number;
  accountId: number;
  parentId?: number | null;
  displayName: string;
  path: string;
  role?: string | null;
  selectable: boolean;
}

export interface EngineMessage {
  id: number;
  threadId: number;
  accountId: number;
  subject: string;
  snippet: string;
  from: EngineAddress;
  to: EngineAddress[];
  /** epoch ms */
  date: number;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  isOutgoing: boolean;
  hasAttachments: boolean;
}

export interface EnginePage {
  messages: EngineMessage[];
  nextCursor?: { date: number; messageId: number } | null;
}

export interface EngineAttachment {
  id: number;
  filename?: string | null;
  mimeType?: string | null;
  size?: number | null;
  isInline: boolean;
}

export interface EngineMessageDetail {
  id: number;
  accountId: number;
  subject: string;
  from: EngineAddress;
  to: EngineAddress[];
  cc: EngineAddress[];
  /** epoch ms */
  date: number;
  isRead: boolean;
  isStarred: boolean;
  htmlBody?: string | null;
  textBody?: string | null;
  attachments: EngineAttachment[];
}

export interface PerformActionArgs {
  kind: string;
  target: { messages?: number[]; threads?: number[] };
  params?: Record<string, unknown> | null;
}
