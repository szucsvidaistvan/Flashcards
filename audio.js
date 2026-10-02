"use strict";
/* Audio: cached in IndexedDB on each device, stored in Supabase Storage so every device can get it.
   Files are uploaded in the background after an import and downloaded on first play. */

/* ---------- IndexedDB (stores: "files" = audio blobs, "queue" = files still to upload) ---------- */
function audioDb() {
  return (audioDb.p ||= new Promise((res) => {
    try {
      const r = indexedDB.open("flashcards-audio", 2);
      r.onupgradeneeded = () => {
        for (const s of ["files", "queue"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  }));
}
async function audioPutMany(entries, store = "files") {
  const db = await audioDb();
  if (!db) throw new Error("Audio storage is not available in this browser.");
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    entries.forEach(([k, v]) => tx.objectStore(store).put(v, k));
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idb(store, method, key) {
  const db = await audioDb();
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction(store, method === "get" ? "readonly" : "readwrite");
    const r = tx.objectStore(store)[method](key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => res(null);
  });
}

/* ---------- Supabase Storage ---------- */
function audioKey(name) {   // short, safe object name derived from the original file name
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const ext = (name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "." + ext;
}
const userId = () => JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
const objectUrl = (name, kind = "object") => `${cfg.url}/storage/v1/${kind}/audio/${userId()}/${audioKey(name)}`;

const inflight = new Map();
// Local copy first; otherwise download it from Supabase Storage and keep it on this device
async function audioGet(name, remote = true) {
  const local = await idb("files", "get", name);
  if (local || !remote || !session) return local;
  if (!inflight.has(name)) {
    inflight.set(name, (async () => {
      try {
        await ensureToken();
        const res = await fetch(objectUrl(name, "object/authenticated"), {
          headers: { apikey: cfg.key, Authorization: "Bearer " + session.access_token },
        });
        if (!res.ok) return null;
        const b = await res.blob();
        const blob = b.type && b.type !== "application/octet-stream" ? b : new Blob([b], { type: "audio/mpeg" });
        await audioPutMany([[name, blob]]);
        return blob;
      } catch { return null; }
      finally { inflight.delete(name); }
    })());
  }
  return inflight.get(name);
}
const audioPrefetch = (names) => (names || []).forEach((n) => audioGet(n));

async function uploadOne(name) {
  const blob = await idb("files", "get", name);
  if (!blob) return "ok";                       // nothing local to upload
  await ensureToken();
  const res = await fetch(objectUrl(name), {
    method: "POST",
    headers: { apikey: cfg.key, Authorization: "Bearer " + session.access_token, "Content-Type": blob.type || "audio/mpeg" },
    body: blob,
  });
  if (res.ok) return "ok";
  const text = await res.text();
  return /duplicate|already exists/i.test(text) ? "ok" : "fail";
}

let uploading = false;
async function uploadPending() {
  if (uploading || !session) return;
  uploading = true;
  try {
    const db = await audioDb();
    if (!db) return;
    const names = await new Promise((res) => {
      const r = db.transaction("queue").objectStore("queue").getAllKeys();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res([]);
    });
    if (!names.length) return;
    let i = 0, left = names.length, failed = false;
    const worker = async () => {
      while (i < names.length && !failed) {
        const name = names[i++];
        try {
          if ((await uploadOne(name)) === "ok") await idb("queue", "delete", name);
          else failed = true;
        } catch { failed = true; }
        left--;
        if (left % 20 === 0) setStatus(`Uploading audio… ${left} left`);
      }
    };
    setStatus(`Uploading audio… ${left} left`);
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    setStatus(failed ? "Audio upload paused – will retry (did you run supabase-audio.sql?)" : "Synced");
  } finally { uploading = false; }
}
window.addEventListener("online", () => uploadPending());
setTimeout(uploadPending, 4000);               // resume unfinished uploads after start

/* ---------- Playback ---------- */
const player = new Audio();
let playToken = 0;
// force = true when the user taps the play button (ignores the autoplay setting)
async function playAudio(names, force = false) {
  const token = ++playToken;
  player.pause();
  if (!names?.length) return;
  if (!force && localStorage.getItem("flashcards-autoplay") === "off") return;
  for (const n of names) {
    if (token !== playToken) return;
    const blob = await audioGet(n);
    if (!blob || token !== playToken) continue;
    const url = URL.createObjectURL(blob);
    try {
      player.src = url;
      await player.play();
      await new Promise((r) => { player.onended = r; player.onerror = r; });
    } catch { /* blocked by the browser or unsupported file */ }
    URL.revokeObjectURL(url);
  }
}
