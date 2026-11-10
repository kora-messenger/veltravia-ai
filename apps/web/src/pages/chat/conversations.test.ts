import { describe, expect, it } from 'vitest';

import {
  archiveConversation,
  createConversation,
  deleteConversation,
  listConversations,
  MAX_TITLE_LENGTH,
  readConversation,
  readConversations,
  RECENT_LIMIT,
  renameConversation,
  restoreConversation,
  saveTurns,
  titleFromText,
  type ConversationStorage,
} from './conversations';

/**
 * The drawer's conversation list is the only memory the product has of a thread,
 * so these pin the two things that would silently lose someone's chats: an
 * unreadable entry taking the whole list down with it, and an ordering that puts
 * an older thread above the one just used.
 */

function fakeStorage(seed: Record<string, string> = {}): ConversationStorage {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('titleFromText', () => {
  it('keeps a short question as typed, on one line', () => {
    expect(titleFromText('  what is\n in the vault?  ')).toBe('what is in the vault?');
  });

  it('names an empty first turn rather than leaving a row blank', () => {
    expect(titleFromText('   ')).toBe('New conversation');
  });

  it('cuts a long first turn at a word, within the limit', () => {
    const words =
      'the quick brown fox jumps over the lazy dog and then keeps on running past the sleeping cat'.split(
        ' ',
      );
    const title = titleFromText(words.join(' '));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH + 1);
    expect(title).not.toContain('runni…');
  });
});

describe('the conversation list', () => {
  it('starts empty and says so, rather than failing to read', () => {
    const store = fakeStorage();
    expect(readConversations(store)).toEqual([]);
    expect(listConversations({}, store)).toEqual([]);
  });

  it('drops a damaged entry instead of losing every other conversation', () => {
    const store = fakeStorage({
      'veltravia.conversations.v1': JSON.stringify([
        { id: 'conv_1', title: 'Kept', createdAt: 1, updatedAt: 1, archived: false, turns: [] },
        { id: 'conv_2', title: 'Broken' },
        'not a record',
      ]),
    });
    const records = readConversations(store);
    expect(records.map((record) => record.title)).toEqual(['Kept']);
  });

  it('treats unparseable storage as no storage', () => {
    const store = fakeStorage({ 'veltravia.conversations.v1': '{oops' });
    expect(readConversations(store)).toEqual([]);
  });

  it('puts the conversation just used first', () => {
    const store = fakeStorage();
    const older = createConversation({ title: 'First', at: 1_000 }, store);
    const newer = createConversation({ title: 'Second', at: 2_000 }, store);
    saveTurns(older.id, [{ id: 't1', role: 'user', text: 'hello' }], store);
    expect(listConversations({}, store).map((record) => record.id)).toEqual([older.id, newer.id]);
  });

  it('leaves an archived conversation out of the list but keeps it readable', () => {
    const store = fakeStorage();
    const record = createConversation({ title: 'Hide me' }, store);
    expect(archiveConversation(record.id, store)?.archived).toBe(true);
    expect(listConversations({}, store)).toEqual([]);
    expect(listConversations({ includeArchived: true }, store)).toHaveLength(1);
    expect(readConversation(record.id, store)?.title).toBe('Hide me');
    expect(restoreConversation(record.id, store)?.archived).toBe(false);
    expect(listConversations({}, store)).toHaveLength(1);
  });

  it('renames a conversation to the new words only', () => {
    const store = fakeStorage();
    const record = createConversation({ title: 'Old name' }, store);
    expect(renameConversation(record.id, '  A better   name ', store)?.title).toBe('A better name');
    // A blank name is refused, so a row can never lose its label.
    expect(renameConversation(record.id, '   ', store)).toBeNull();
    expect(readConversation(record.id, store)?.title).toBe('A better name');
  });

  it('deletes a conversation and reports whether there was one', () => {
    const store = fakeStorage();
    const record = createConversation({ title: 'Delete me' }, store);
    expect(deleteConversation(record.id, store)).toBe(true);
    expect(deleteConversation(record.id, store)).toBe(false);
    expect(readConversations(store)).toEqual([]);
  });

  it('stores finished turns and nothing else', () => {
    const store = fakeStorage();
    const record = createConversation({ title: 'Q' }, store);
    saveTurns(
      record.id,
      [
        { id: 't1', role: 'user', text: 'Q' },
        { id: 't2', role: 'assistant', text: 'A' },
      ],
      store,
    );
    expect(readConversation(record.id, store)?.turns.map((turn) => turn.text)).toEqual(['Q', 'A']);
    // Saving into a conversation that is not there is not a new conversation.
    expect(saveTurns('conv_missing', [], store)).toBeNull();
  });

  it('caps what a drawer shows at nine before offering the rest', () => {
    const store = fakeStorage();
    for (let index = 0; index < 12; index += 1) {
      createConversation({ title: `Chat ${index}`, at: 1_000 + index }, store);
    }
    const all = listConversations({}, store);
    expect(all).toHaveLength(12);
    expect(all.slice(0, RECENT_LIMIT)).toHaveLength(9);
    expect(RECENT_LIMIT).toBe(9);
  });

  it('works with no storage at all, so a private window still opens the drawer', () => {
    const record = createConversation({ title: 'Ephemeral' }, null);
    expect(record.title).toBe('Ephemeral');
    expect(readConversations(null)).toEqual([]);
    expect(saveTurns(record.id, [], null)).toBeNull();
    expect(deleteConversation(record.id, null)).toBe(false);
  });
});
