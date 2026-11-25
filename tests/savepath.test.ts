// Run: npx tsx tests/savepath.test.ts - saving to the device and reading back: a reload with undo history,
// a write that fails, an autosave the app can't read, a project list that can't be read.
// No geometry engine: a small IndexedDB stand-in kept in memory.

let failed = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, info);
};

// ------------------------------------------------------ IndexedDB stand-in

const stored = new Map<string, string>();
const fault = { write: false, readKey: '' };
const later = (fn: () => void) => setTimeout(fn, 0);

function request<T>(work: () => T, failWith?: Error) {
  const req: { result?: T; error: Error | null; onsuccess?: () => void; onerror?: () => void } = { error: null };
  later(() => {
    if (failWith) {
      req.error = failWith;
      req.onerror?.();

      return;
    }
    req.result = work();
    req.onsuccess?.();
  });

  return req;
}

function transaction(mode = 'readonly') {
  const pending: (() => void)[] = [];
  const tx: { error: Error | null; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
    error: null,
    objectStore: () => ({
      get: (key: string) => request(() => stored.get(key), fault.readKey === key ? new Error('read failed') : undefined),
      put: (value: string, key: string) => pending.push(() => stored.set(key, value)),
      delete: (key: string) => pending.push(() => stored.delete(key))
    })
  };
  later(() => {
    if (mode === 'readwrite' && fault.write) {
      tx.error = new Error('QuotaExceededError');
      tx.onerror?.();
      tx.onabort?.();

      return;
    }
    pending.forEach(apply => apply());
    tx.oncomplete?.();
  });

  return tx;
}

(globalThis as any).window ??= globalThis;
(globalThis as any).indexedDB = {
  open: () => {
    const req = request(() => ({ transaction: (_name: string, mode?: string) => transaction(mode), createObjectStore: () => undefined }));

    return req;
  }
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A fresh copy of the store module: what a page reload starts with. */
let reloads = 0;
const freshStore = () => import(`../src/doc/store.ts?reload=${++reloads}`) as Promise<typeof import('../src/doc/store')>;

// ------------------------------------------- undo after a reload, big values
{
  const big = (letter: string) => letter.repeat(60000);
  // Each under the size kept by reference, 4.5 MB together: too much for the saved history.
  const filler = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, 'f'.repeat(45000)]));
  const first = await freshStore();
  const store = new first.DocStore();
  await store.load();
  store.commit((draft) => {
    draft.name = big('x');
    draft.names = filler;
  });
  store.commit((draft) => {
    draft.name = big('y');
    draft.names = {};
  });
  store.commit(draft => (draft.name = 'small'));
  await store.flush();

  // The saved history keeps the undo step holding "y" (id 1), not the bigger one holding "x" (id 0).
  const second = await freshStore();
  const reloaded = new second.DocStore();
  await reloaded.load();
  check('reload: the project comes back', reloaded.doc.name === 'small');
  check('reload: some undo comes back', reloaded.canUndo);
  reloaded.commit(draft => (draft.name = big('w')));
  reloaded.undo();
  reloaded.undo();
  check('reload: undo past a new big value still shows the old one', reloaded.doc.name === big('y'), reloaded.doc.name.slice(0, 3));
  await reloaded.flush();
}

// ----------------------------------------------------------- a failed write
{
  stored.clear();
  const { DocStore } = await freshStore();
  const store = new DocStore();
  await store.load();
  fault.write = true;
  store.commit(draft => (draft.name = 'unsaved'));
  let rejected = false;
  await store.flush().catch(() => (rejected = true));
  check('failed write: flush says so', rejected);
  check('failed write: not marked saved', !store.saved);
  check('failed write: nothing stored', !stored.has('autosave'));
  fault.write = false;
  await store.flush();
  check('write works again: marked saved', store.saved && JSON.parse(stored.get('autosave')!).name === 'unsaved');
}

// ----------------------------------------------- a change before the load
{
  stored.clear();
  const { DocStore } = await freshStore();
  const store = new DocStore();
  store.commit(draft => (draft.name = 'too early'));
  await wait(500);
  check('before load: a change saves nothing', !stored.has('autosave'));
}

// ------------------------------------------------ an autosave it can't read
{
  stored.clear();
  const newer = JSON.stringify({ format: 'super', version: 3, name: 'From a newer app', features: [] });
  stored.set('autosave', newer);
  const { DocStore } = await freshStore();
  const store = new DocStore();
  await store.load();
  check('unreadable autosave: noticed', store.loadFailed);
  check('unreadable autosave: kept aside', stored.get('autosave-unread') === newer);
  check('unreadable autosave: an empty project opens', store.features.length === 0);
}

// ------------------------------------------- a project list it can't read
{
  stored.clear();
  const library = await import(`../src/doc/library.ts?reload=${++reloads}`) as typeof import('../src/doc/library');
  await library.keepProject('p-1', 'One', '{}');
  await library.keepProject('p-2', 'Two', '{}');
  fault.readKey = 'library';
  let rejected = false;
  await library.keepProject('p-3', 'Three', '{}').catch(() => (rejected = true));
  fault.readKey = '';
  const names = (await library.libraryEntries()).map(entry => entry.name).sort().join(',');
  check('unreadable list: the edit fails', rejected);
  check('unreadable list: no project is dropped from it', names === 'One,Two', names);
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
