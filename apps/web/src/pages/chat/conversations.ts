/**
 * The list of conversations this browser has had.
 *
 * Until accounts exist there is nowhere on the server to keep a thread, so the
 * list lives in the browser and is honest about it: a different browser, or a
 * cleared cache, starts from nothing. Nothing here is presented as durable
 * storage, and a record that cannot be read is dropped rather than guessed at.
 *
 * Only finished turns are kept. A turn still in flight, or one that failed, is
 * not a conversation anyone can reopen.
 */

export type StoredRole = 'user' | 'assistant';

export interface StoredTurn {
  readonly id: string;
  readonly role: StoredRole;
  readonly text: string;
}

export interface ConversationRecord {
  readonly id: string;
  readonly title: string;
  /** Where the thread began, in epoch milliseconds. */
  readonly createdAt: number;
  /** The last turn, in epoch milliseconds. Drives the newest-first order. */
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly turns: readonly StoredTurn[];
}

/** How many rows the drawer shows before it offers "See all". */
export const RECENT_LIMIT = 9;

/** A title is a row label, not a paragraph. */
export const MAX_TITLE_LENGTH = 80;

const STORAGE_KEY = 'veltravia.conversations.v1';

/** Fired whenever the list changes, so every open surface agrees at once. */
export const CONVERSATIONS_CHANGED_EVENT = 'veltravia:conversations-changed';

/** Fired when a conversation is chosen and the thread should show it. */
export const OPEN_CONVERSATION_EVENT = 'veltravia:open-conversation';

/** The storage this module reads and writes. Narrow on purpose, so tests fake it. */
export interface ConversationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A browser's localStorage, or null where there is none (a private window, a
 * sandboxed frame). Null means "this list is empty", never a thrown error in
 * the middle of rendering.
 */
function defaultStorage(): ConversationStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    const store = window.localStorage;
    // Touching it can throw even when the property exists.
    const probe = '__veltravia_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

function isStoredTurn(value: unknown): value is StoredTurn {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.id === 'string' &&
    (turn.role === 'user' || turn.role === 'assistant') &&
    typeof turn.text === 'string'
  );
}

function isRecord(value: unknown): value is ConversationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.archived === 'boolean' &&
    Array.isArray(record.turns) &&
    record.turns.every(isStoredTurn)
  );
}

/** Every record, newest first. A damaged entry is dropped, never repaired. */
export function readConversations(store: ConversationStorage | null = defaultStorage()) {
  if (store === null) return [] as ConversationRecord[];
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return [] as ConversationRecord[];
  }
  if (raw === null || raw.trim() === '') return [] as ConversationRecord[];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable storage is treated as no storage. The alternative is a crash in
    // the navigation drawer, which would take the whole app with it.
    return [] as ConversationRecord[];
  }
  if (!Array.isArray(parsed)) return [] as ConversationRecord[];
  return parsed.filter(isRecord).sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeAll(
  records: readonly ConversationRecord[],
  store: ConversationStorage | null = defaultStorage(),
): void {
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // A full or blocked store is a list that does not grow, not a failed turn.
  }
  announce();
}

function announce(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
}

/**
 * A short title from the first thing the person said: one line, its own words,
 * cut at a word boundary rather than mid-word where that is possible.
 */
export function titleFromText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'New conversation';
  if (flat.length <= MAX_TITLE_LENGTH) return flat;
  const cut = flat.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > MAX_TITLE_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/** The conversations a drawer lists: unarchived unless asked otherwise. */
export function listConversations(
  options: { readonly includeArchived?: boolean } = {},
  store: ConversationStorage | null = defaultStorage(),
): readonly ConversationRecord[] {
  const records = readConversations(store);
  return options.includeArchived === true ? records : records.filter((r) => !r.archived);
}

export function readConversation(
  id: string,
  store: ConversationStorage | null = defaultStorage(),
): ConversationRecord | null {
  return readConversations(store).find((record) => record.id === id) ?? null;
}

let sequence = 0;

/** An id that is unique within this browser without needing a server. */
function newId(prefix: string, at: number): string {
  sequence += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${at.toString(36)}_${sequence.toString(36)}${random}`;
}

export interface NewConversation {
  readonly title: string;
  readonly turns?: readonly StoredTurn[];
  readonly at?: number;
}

export function createConversation(
  input: NewConversation,
  store: ConversationStorage | null = defaultStorage(),
): ConversationRecord {
  const at = input.at ?? Date.now();
  const record: ConversationRecord = {
    id: newId('conv', at),
    title: titleFromText(input.title),
    createdAt: at,
    updatedAt: at,
    archived: false,
    turns: input.turns ?? [],
  };
  writeAll([record, ...readConversations(store)], store);
  return record;
}

/**
 * Replaces a thread's turns and moves it to the top of the list.
 *
 * Saving an empty thread is allowed: a conversation whose only message is still
 * being answered exists, and hiding it until the answer lands would make the
 * drawer disagree with the screen.
 */
export function saveTurns(
  id: string,
  turns: readonly StoredTurn[],
  store: ConversationStorage | null = defaultStorage(),
): ConversationRecord | null {
  const records = readConversations(store);
  const existing = records.find((record) => record.id === id);
  if (existing === undefined) return null;
  const next: ConversationRecord = { ...existing, turns, updatedAt: Date.now() };
  writeAll([next, ...records.filter((record) => record.id !== id)], store);
  return next;
}

export function renameConversation(
  id: string,
  title: string,
  store: ConversationStorage | null = defaultStorage(),
): ConversationRecord | null {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  return update(id, { title: titleFromText(trimmed) }, store);
}

export function archiveConversation(
  id: string,
  store: ConversationStorage | null = defaultStorage(),
): ConversationRecord | null {
  return update(id, { archived: true }, store);
}

export function restoreConversation(
  id: string,
  store: ConversationStorage | null = defaultStorage(),
): ConversationRecord | null {
  return update(id, { archived: false }, store);
}

export function deleteConversation(
  id: string,
  store: ConversationStorage | null = defaultStorage(),
): boolean {
  const records = readConversations(store);
  if (!records.some((record) => record.id === id)) return false;
  writeAll(
    records.filter((record) => record.id !== id),
    store,
  );
  return true;
}

function update(
  id: string,
  patch: Partial<Pick<ConversationRecord, 'title' | 'archived'>>,
  store: ConversationStorage | null,
): ConversationRecord | null {
  const records = readConversations(store);
  const existing = records.find((record) => record.id === id);
  if (existing === undefined) return null;
  const next: ConversationRecord = { ...existing, ...patch };
  writeAll(
    records.map((record) => (record.id === id ? next : record)),
    store,
  );
  return next;
}

/**
 * Asks whichever surface is showing the thread to display this conversation.
 * A plain window event, because the drawer and the chat page sit on opposite
 * sides of the shell.
 */
export function requestOpenConversation(id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: { id } }));
}
