"use strict";
/* Local database (IndexedDB): no 5 MB limit like localStorage, so even 20 000 cards load instantly. */
const kv = {
  open() {
    return (this.p ||= new Promise((res) => {
      try {
        const r = indexedDB.open("flashcards-data", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch { res(null); }
    }));
  },
  async get(key) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((res) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  },
  async set(key, val) {
    const db = await this.open();
    if (!db) throw new Error("Local storage is not available");
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
};
