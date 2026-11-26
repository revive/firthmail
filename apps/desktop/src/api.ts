import { invoke } from '@tauri-apps/api/core';
import type { EngineAccount, EngineFolder, EngineMessage, EngineMessageDetail, EnginePage, PerformActionArgs } from './types';

/** Input shape of the engine's `AddPasswordAccountArgs` (camelCase JSON). */
export interface AddAccountInput {
  email: string;
  displayName?: string | null;
  username: string;
  password: string;
  mailProtocol: 'imap' | 'pop3';
  incomingHost: string;
  incomingPort: number;
  smtpHost: string;
  smtpPort: number;
  connection: {
    incomingSecurity: 'tls' | 'starttls' | 'none';
    smtpSecurity: 'tls' | 'starttls' | 'none';
  };
}

/** One folder a local-mail scan found. */
export interface ScanFolderOut {
  index: number;
  name: string;
  kind: string;
  sizeBytes: number;
  selectable: boolean;
}

/** Input shape of the engine's `SaveDraftArgs` (camelCase JSON). */
export interface SaveDraftInput {
  draftId: number | null;
  accountId: number;
  from: { name: string | null; email: string } | null;
  to: { name: string | null; email: string }[];
  cc: { name: string | null; email: string }[];
  bcc: { name: string | null; email: string }[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  mode: 'reply' | 'forward' | 'new';
  inReplyToMessageId: number | null;
  inReplyToHeader: string | null;
  attachments: [];
  requestReadReceipt: boolean;
  importance: 'low' | 'normal' | 'high';
}

export interface FolderRoleChoiceOut {
  role: string;
  suggested: number | null;
  chosen: number | null;
}

export const api = {
  listAccounts: () => invoke<EngineAccount[]>('list_accounts'),
  /** 第一帧渲染完后显示主窗口（窗口在配置里默认隐藏）。 */
  showMainWindow: () => invoke('show_main_window'),
  addAccount: (args: AddAccountInput) => invoke<EngineAccount>('add_account', { args }),
  removeAccount: (accountId: number) => invoke('remove_account', { accountId }),
  /** The Microsoft OAuth application (client) ID saved for Outlook.com sign-in. */
  oauthClientId: () => invoke<string>('oauth_client_id'),
  setOauthClientId: (clientId: string) => invoke<void>('set_oauth_client_id', { clientId }),
  /** Opens the Microsoft sign-in page and resolves once the account is added. */
  startMicrosoftLogin: () => invoke<EngineAccount>('start_microsoft_login'),
  cancelOauth: () => invoke<void>('cancel_oauth'),
  listFolders: (accountId: number | null) => invoke<EngineFolder[]>('list_folders', { accountId }),
  accountFolderRoles: (accountId: number) =>
    invoke<{ roles: FolderRoleChoiceOut[] }>('account_folder_roles', { accountId }),
  /** Mark every message in a folder read (locally now, on the server queued). */
  markFolderRead: (folderId: number, view: string) =>
    invoke<{ actionIds: number[] }>('mark_folder_read', { folderId, view }),
  listMessages: (folderId: number | null, view = 'all', limit = 100, cursor: { date: number; messageId: number } | null = null) =>
    invoke<EnginePage>('list_messages', { view, accountId: null, folderId, cursor, limit }),
  /** One view across several accounts (a mailbox split into IMAP + local import). */
  listMessagesMerged: (accountIds: number[], view = 'all', limit = 100, cursor: { date: number; messageId: number } | null = null) =>
    invoke<EnginePage>('list_messages_merged', { accountIds, view, cursor, limit }),
  getBody: (messageId: number) => invoke<EngineMessageDetail>('get_body', { messageId }),
  performAction: (args: PerformActionArgs) => invoke<{ actionIds: number[] }>('perform_action', { args }),
  emptyTrash: (accountId: number | null) => invoke('empty_trash', { accountId }),
  syncNow: () => invoke('sync_now'),
  scanImport: (root: string) => invoke<ScanFolderOut[]>('scan_import', { root }),
  /** Native folder picker; null when the user cancels. */
  pickFolder: () => invoke<string | null>('pick_folder'),
  /** Native file picker limited to .ost/.pst; null when the user cancels. */
  pickOutlookFile: () => invoke<string | null>('pick_outlook_file'),
  importLocalMail: (
    root: string,
    folders: number[],
    ownAddresses: string[],
    skipExisting = true,
  ) => invoke('import_local_mail', { root, folders, ownAddresses, skipExisting }),
  /** Convert an Outlook .ost/.pst with the bundled ost2eml, then import it. */
  importOutlookFile: (path: string, ownAddresses: string[] = []) =>
    invoke('import_outlook_file', { path, ownAddresses }),
  cancelImport: () => invoke('cancel_import'),
  saveDraft: (args: SaveDraftInput) => invoke<number>('save_draft', { args }),
  queueSend: (draftId: number) =>
    invoke<{ actionId: number; draftId: number; dispatchAt: number }>('queue_send', { draftId }),
  searchMessages: (query: string, limit = 100) =>
    invoke<EngineMessage[]>('search_messages', { query, limit }),
  diag: () => invoke<number>('diag'),
};
