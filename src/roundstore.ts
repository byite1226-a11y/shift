/**
 * Per-round logs for playtests, kept in IndexedDB so a reload or crash does not lose a session.
 * Falls back to memory when IndexedDB is unavailable. The facilitator exports everything with one download.
 */
const DB_NAME = 'shift.gate02.rounds';
const STORE = 'rounds';
let memory: object[] = [];
let dbPromise: Promise<IDBDatabase | null> | null = null;

/** One shared connection: concurrent first-time opens would otherwise race on the upgrade and fall back to memory. */
function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbPromise = null; }; resolve(req.result); };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Endless rounds can log ~2 MB each (10 min); keep the newest MAX_STORED and drop the oldest beyond that. */
export const MAX_STORED = 60;

/** Store one finished round. Resolves to the number of rounds now stored. */
export async function saveRound(log: object): Promise<number> {
  const db = await open();
  if (!db) { memory.push(log); if (memory.length > MAX_STORED) memory.splice(0, memory.length - MAX_STORED); return memory.length; }
  try {
    await run(db, 'readwrite', (s) => s.add(log));
    let count = await run(db, 'readonly', (s) => s.count());
    while (count > MAX_STORED) {
      const oldestKey = await run(db, 'readonly', (s) => s.getAllKeys(undefined, 1));
      if (!oldestKey.length) break;
      await run(db, 'readwrite', (s) => s.delete(oldestKey[0]));
      count--;
    }
    return count + memory.length;
  } catch {
    memory.push(log);
    return memory.length;
  }
}

export async function loadRounds(): Promise<object[]> {
  const db = await open();
  if (!db) return memory.slice();
  try { return [...(await run(db, 'readonly', (s) => s.getAll())), ...memory]; }
  catch { return memory.slice(); }
}

export async function countRounds(): Promise<number> {
  const db = await open();
  if (!db) return memory.length;
  try { return (await run(db, 'readonly', (s) => s.count())) + memory.length; }
  catch { return memory.length; }
}

export async function clearRounds(): Promise<void> {
  memory = [];
  const db = await open();
  if (!db) return;
  try { await run(db, 'readwrite', (s) => s.clear()); }
  catch { /* nothing to do */ }
}
