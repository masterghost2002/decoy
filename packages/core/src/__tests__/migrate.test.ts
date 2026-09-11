import { describe, expect, it, vi } from 'vitest';

import { migrateStorageKeys, type StorageArea } from '../migrate.js';

/** A storage area that behaves like `chrome.storage.local`, in a plain object. */
function fakeArea(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  const area: StorageArea = {
    get: (keys) =>
      Promise.resolve(
        Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])),
      ),
    set: (items) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const key of keys) delete data[key];
      return Promise.resolve();
    },
  };
  return { area, data };
}

const RENAME = [{ from: 'old.config.v1', to: 'new.config.v1' }];

describe('migrateStorageKeys', () => {
  it('carries the value across and drops the old key', async () => {
    const { area, data } = fakeArea({ 'old.config.v1': { rules: ['a rule'] } });

    const report = await migrateStorageKeys(area, RENAME);

    expect(report.moved).toEqual(['old.config.v1']);
    expect(data['new.config.v1']).toEqual({ rules: ['a rule'] });
    expect('old.config.v1' in data).toBe(false);
  });

  it('keeps the newer value when both names hold something', async () => {
    // The case that would lose someone's work: a profile that has run both
    // names must not have its current rules replaced by an older copy.
    const { area, data } = fakeArea({
      'old.config.v1': { rules: ['stale'] },
      'new.config.v1': { rules: ['current'] },
    });

    const report = await migrateStorageKeys(area, RENAME);

    expect(report).toEqual({ moved: [], skipped: ['old.config.v1'] });
    expect(data['new.config.v1']).toEqual({ rules: ['current'] });
    // Still removed, or this would be repeated on every single startup.
    expect('old.config.v1' in data).toBe(false);
  });

  it('does nothing, and writes nothing, when there is nothing to move', async () => {
    const { area } = fakeArea({ 'new.config.v1': { rules: [] } });
    const set = vi.spyOn(area, 'set');
    const remove = vi.spyOn(area, 'remove');

    expect(await migrateStorageKeys(area, RENAME)).toEqual({ moved: [], skipped: [] });
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const { area, data } = fakeArea({ 'old.config.v1': 1 });
    await migrateStorageKeys(area, RENAME);
    const second = await migrateStorageKeys(area, RENAME);
    expect(second).toEqual({ moved: [], skipped: [] });
    expect(data['new.config.v1']).toBe(1);
  });

  it('carries a falsy value across, which `undefined` checks get wrong', async () => {
    const { area, data } = fakeArea({ 'old.config.v1': false });
    await migrateStorageKeys(area, RENAME);
    expect(data['new.config.v1']).toBe(false);
  });

  it('moves several keys in one pass, independently', async () => {
    const { area, data } = fakeArea({ 'old.a': 1, 'old.b': 2, 'new.b': 'already here' });

    const report = await migrateStorageKeys(area, [
      { from: 'old.a', to: 'new.a' },
      { from: 'old.b', to: 'new.b' },
      { from: 'old.c', to: 'new.c' },
    ]);

    expect(report).toEqual({ moved: ['old.a'], skipped: ['old.b'] });
    expect(data['new.a']).toBe(1);
    expect(data['new.b']).toBe('already here');
    expect('new.c' in data).toBe(false);
  });

  it('lets a storage failure reject, so the caller can decide', async () => {
    const { area } = fakeArea({ 'old.config.v1': 1 });
    vi.spyOn(area, 'set').mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(migrateStorageKeys(area, RENAME)).rejects.toThrow('quota exceeded');
  });
});
