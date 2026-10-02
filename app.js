"use strict";

/* ---------- Storage (localStorage) ---------- */
const STORAGE_KEY = "kartyatar-v1";
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

let state = load();
state.pending ||= []; // operations not yet synced
let currentDeckId = null;
let queue = [];
let current = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { decks: [] };
  } catch {
    return { decks: [] };
  }
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser storage is full (very large collections): keep only the sync queue.
    // The decks are downloaded from Supabase on the next start.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ decks: [], pending: state.pending })); } catch {}
  }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const $ = (id) => document.getElementById(id);
const deckById = (id) => state.decks.find((d) => d.id === id);

/* ---------- Deck tree helpers (Anki-style "Parent::Child" names) ---------- */
const SEP = "::";
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const lastSeg = (name) => name.split(SEP).pop();
const shortName = (name) => name.split(SEP).slice(-2).join(" › ");
const parentPath = (p) => p.split(SEP).slice(0, -1).join(SEP);
const decksUnder = (path) => (path === "" ? state.decks : state.decks.filter((d) => d.name === path || d.name.startsWith(path + SEP)));

// New cards per day (like Anki), counted on this device
const todayKey = () => new Date().toLocaleDateString("en-CA");
function newLimit() {
  const v = localStorage.getItem("flashcards-newperday");
  return v === null ? 20 : Math.max(0, +v || 0);
}
function newDoneToday() {
  try {
    const o = JSON.parse(localStorage.getItem("flashcards-newtoday"));
    return o?.date === todayKey() ? o.n : 0;
  } catch { return 0; }
}
const addNewDone = () => localStorage.setItem("flashcards-newtoday", JSON.stringify({ date: todayKey(), n: newDoneToday() + 1 }));
const newLeft = () => Math.max(0, newLimit() - newDoneToday());

let browsePath = "";   // folder shown in the Cards tab
let studyFrom = null;  // where "Exit" returns to
const PAGE = 200;      // cards per page in the card list

/* ---------- Supabase sync ---------- */
const CFG_KEY = "kartyatar-supabase";
// Fixed Supabase project (the publishable key is meant for browsers, it is not a secret)
const cfg = {
  url: "https://atkblxtzromzfewtwmgq.supabase.co",
  key: "sb_publishable_qZpDJaXm7iDFt7KIt-WwRA_J_u_g6ZX",
};

/* ---------- Google sign-in (Supabase Auth, implicit flow) ---------- */
const SESSION_KEY = "kartyatar-session";
let session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
let authError = "";

function saveSession(x) {
  session = x;
  if (x) localStorage.setItem(SESSION_KEY, JSON.stringify(x));
  else localStorage.removeItem(SESSION_KEY);
  $("account-email").textContent = x?.email || "";
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("error_description")) authError = p.get("error_description");
  const token = p.get("access_token");
  if (token) {
    let email = "";
    try { email = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch {}
    saveSession({
      access_token: token,
      refresh_token: p.get("refresh_token"),
      expires_at: Math.floor(Date.now() / 1000) + Number(p.get("expires_in") || 3600),
      email,
    });
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}
async function ensureToken() {
  if (!session || session.expires_at - 60 > Date.now() / 1000) return;
  const res = await fetch(cfg.url + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { apikey: cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) { saveSession(null); showLogin(); throw new Error("Session expired"); }
  const t = await res.json();
  saveSession({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, email: session.email });
}
function showLogin() {
  show("login");
  $("login-error").textContent = authError;
}
function login() {
  try {
    $("login-error").textContent = "Redirecting to Google…";
    const back = encodeURIComponent(location.origin + location.pathname);
    location.href = `${cfg.url}/auth/v1/authorize?provider=google&redirect_to=${back}`;
  } catch (e) {
    $("login-error").textContent = "Error: " + e.message;
  }
}
let flushing = false;

const setStatus = (t) => ($("sync-status").textContent = t);
const toRow = (c, deckId) => ({
  id: c.id, deck_id: deckId, front: c.front, back: c.back,
  ease: c.ease, interval_days: c.interval, reps: c.reps, due: c.due,
  ...(c.aq || c.aa ? { audio: { q: c.aq || [], a: c.aa || [] } } : {}),
});
const fromRow = (r) => withAudio(r, {
  id: r.id, front: r.front, back: r.back,
  ease: r.ease, interval: r.interval_days, reps: r.reps, due: Number(r.due),
});
function withAudio(r, card) {
  if (r.audio?.q?.length) card.aq = r.audio.q;
  if (r.audio?.a?.length) card.aa = r.audio.a;
  return card;
}

async function api(path, method = "GET", body) {
  await ensureToken();
  const res = await fetch(cfg.url.replace(/\/$/, "") + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + session.access_token,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return method === "GET" ? res.json() : null;
}

// Every change goes into a queue and is sent to the server in order.
// If you are offline, the queue is kept and resumes later.
function enqueue(type, id) {
  state.pending.push({ type, id });
  save();
  flush();
}

async function flush() {
  if (!session || flushing) return;
  flushing = true;
  try {
    while (state.pending.length) {
      const op = state.pending[0];
      if (op.type === "deck" || op.type === "card") {
        // Send consecutive upserts in one request (up to 500 rows) – much faster for big imports
        let n = 0;
        while (n < state.pending.length && n < 500 && state.pending[n].type === op.type) n++;
        const ids = new Set(state.pending.slice(0, n).map((o) => o.id));
        const rows = [];
        if (op.type === "deck") {
          for (const d of state.decks) if (ids.has(d.id)) rows.push({ id: d.id, name: d.name });
        } else {
          for (const d of state.decks) for (const c of d.cards) if (ids.has(c.id)) rows.push(toRow(c, d.id));
        }
        if (rows.length) await api((op.type === "deck" ? "decks" : "cards") + "?on_conflict=id", "POST", rows);
        state.pending.splice(0, n);
      } else {
        await api((op.type === "delDeck" ? "decks" : "cards") + "?id=eq." + encodeURIComponent(op.id), "DELETE");
        state.pending.shift();
      }
      save();
      setStatus(`Syncing… (${state.pending.length} left)`);
    }
    setStatus("Synced");
  } catch (e) {
    console.error(e);
    setStatus("Offline – will retry later");
  }
  flushing = false;
}

// Supabase returns at most 1000 rows per request, so read the tables page by page
async function fetchAll(table) {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const page = await api(`${table}?select=*&order=created_at,id&limit=1000&offset=${off}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}
async function pull() {
  const decks = await fetchAll("decks");
  const cards = await fetchAll("cards");
  if (!decks.length && state.decks.length) {
    // First run: upload the existing local data
    for (const d of state.decks) state.pending.push({ type: "deck", id: d.id });
    for (const d of state.decks) for (const c of d.cards) state.pending.push({ type: "card", id: c.id });
    save();
    await flush();
    return;
  }
  const byDeck = new Map();
  for (const r of cards) {
    if (!byDeck.has(r.deck_id)) byDeck.set(r.deck_id, []);
    byDeck.get(r.deck_id).push(r);
  }
  const cmp = (x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : natural(x.id, y.id));
  state.decks = decks.map((d) => ({
    id: d.id, name: d.name,
    cards: (byDeck.get(d.id) || []).sort(cmp).map(fromRow),
  }));
  save();
}
async function syncInit() {
  if (!session) return showLogin();
  setStatus("Syncing…");
  await flush();
  if (state.pending.length) return;
  try {
    await pull();
    setStatus("Synced");
  } catch (e) {
    console.error(e);
    setStatus("Offline");
  }
  renderDecks();
}
window.addEventListener("online", syncInit);

/* ---------- Scheduling (simplified SM-2) ---------- */
function newCard(front, back) {
  return { id: uid(), front, back, ease: 2.5, interval: 0, reps: 0, due: 0 };
}
const isNew = (c) => c.reps === 0 && c.due === 0;
const isDue = (c) => c.due <= Date.now();

// Returns the new card state; the button previews use it too
function schedule(card, rating) {
  let { ease, interval, reps } = card;
  let due;
  if (rating === "again") {
    reps = 0;
    ease = Math.max(1.3, ease - 0.2);
    interval = 0;
    due = Date.now() + MIN;
  } else {
    if (rating === "hard") {
      interval = Math.max(1, Math.round(interval * 1.2));
      ease = Math.max(1.3, ease - 0.15);
    } else if (rating === "good") {
      interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(interval * ease);
    } else {
      interval = reps === 0 ? 4 : Math.round(Math.max(interval, 1) * ease * 1.3);
      ease += 0.15;
    }
    reps += 1;
    due = Date.now() + interval * DAY;
  }
  return { ease, interval, reps, due };
}
function label(card, rating) {
  const s = schedule(card, rating);
  if (rating === "again") return "1 min";
  return s.interval === 1 ? "1 day" : s.interval + " days";
}

/* ---------- Views ---------- */
function show(view) {
  for (const v of ["login", "decks", "deck", "study", "games", "game", "settings"]) $("view-" + v).hidden = v !== view;
  const tab = { decks: "decks", deck: "decks", games: "games", settings: "settings" }[view];
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.body.classList.toggle("immersive", view === "study" || view === "game" || view === "login");
  window.scrollTo(0, 0);
}
function counts(decks) {
  let total = 0, n = 0, due = 0;
  for (const d of decks) for (const c of d.cards) { total++; if (isNew(c)) n++; else if (isDue(c)) due++; }
  return { total, n: Math.min(n, newLeft()), due };
}
function countsHtml(c) {
  return `<span class="counts"><span class="c-new">${c.n} new</span><span class="c-due">${c.due} due</span></span>`;
}

// Cards tab: shows the folders / decks inside browsePath, like the Anki deck list
function renderDecks(path = browsePath) {
  while (path && !decksUnder(path).length) path = parentPath(path);   // folder disappeared
  browsePath = path;
  currentDeckId = null;
  show("decks");
  const inside = path !== "";
  $("browse-back").hidden = !inside;
  $("decks-title").textContent = inside ? lastSeg(path) : "Cards";
  $("browse-path").textContent = path.split(SEP).join(" › ");
  const c = counts(decksUnder(path));
  $("folder-study").hidden = !inside;
  $("folder-study").textContent = `Study everything in this folder (${c.n} new · ${c.due} due)`;
  $("folder-study").disabled = c.n + c.due === 0;

  const list = $("deck-list");
  list.innerHTML = "";
  const kids = new Map();
  let own = null;
  for (const d of state.decks) {
    if (inside && d.name === path) { own = d; continue; }
    if (inside && !d.name.startsWith(path + SEP)) continue;
    const rest = inside ? d.name.slice(path.length + SEP.length) : d.name;
    const seg = rest.split(SEP)[0];
    const node = kids.get(seg) || { seg, path: inside ? path + SEP + seg : seg, deck: null, folder: false };
    if (rest.includes(SEP)) node.folder = true; else node.deck = d;
    kids.set(seg, node);
  }
  const addRow = (title, cnt, folder, open) => {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `<span class="deck-name"></span>${countsHtml(cnt)}${folder ? '<span class="chev">›</span>' : ""}`;
    li.querySelector(".deck-name").textContent = title;
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => e.key === "Enter" && open());
    list.append(li);
  };
  if (own) addRow("Cards in this deck", counts([own]), false, () => renderDeck(own.id));
  [...kids.values()].sort((x, y) => natural(x.seg, y.seg)).forEach((k) => {
    const open = k.folder ? () => renderDecks(k.path) : () => renderDeck(k.deck.id);
    addRow(k.seg, counts(decksUnder(k.path)), k.folder, open);
  });
  if (!list.children.length) list.innerHTML = '<li class="empty">No decks yet. Create your first one above.</li>';
}

function renderDeck(id, page = 0) {
  currentDeckId = id;
  const d = deckById(id);
  show("deck");
  $("deck-title").textContent = lastSeg(d.name);
  $("deck-path").textContent = parentPath(d.name).split(SEP).join(" › ");
  const c = counts([d]);
  $("study-btn").disabled = c.n + c.due === 0;

  const pages = Math.max(1, Math.ceil(d.cards.length / PAGE));
  const cardPage = Math.min(page, pages - 1);
  const from = cardPage * PAGE;
  const slice = d.cards.slice(from, from + PAGE);
  $("deck-stats").textContent = `${c.total} cards · ${c.n} new today · ${c.due} due`;
  $("pager").hidden = d.cards.length <= PAGE;
  $("pager-info").textContent = `${from + 1}–${from + slice.length} of ${d.cards.length}`;
  $("page-prev").disabled = cardPage === 0;
  $("page-next").disabled = cardPage >= pages - 1;
  $("page-prev").onclick = () => renderDeck(id, cardPage - 1);
  $("page-next").onclick = () => renderDeck(id, cardPage + 1);

  const list = $("card-list");
  list.innerHTML = "";
  if (!d.cards.length) list.innerHTML = '<li class="empty">Add your first card above.</li>';
  for (const card of slice) {
    const li = document.createElement("li");
    const a = document.createElement("span");
    const b = document.createElement("span");
    a.textContent = card.front;
    b.textContent = card.back;
    const del = document.createElement("button");
    del.className = "danger small";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      d.cards = d.cards.filter((x) => x.id !== card.id);
      enqueue("delCard", card.id);
      renderDeck(id, cardPage);
    });
    const tag = document.createElement("span");
    tag.className = "due-tag";
    tag.textContent = isNew(card) ? "New" : isDue(card) ? "Due" : "Next: " + new Date(card.due).toLocaleDateString("en-US");
    li.append(a, b, del, tag);
    list.append(li);
  }
}

/* ---------- Study ---------- */
function startStudy(scope, from) {
  studyFrom = from;
  const due = [], fresh = [];
  for (const d of [...scope].sort((x, y) => natural(x.name, y.name)))
    for (const c of d.cards) {
      if (isNew(c)) fresh.push(c);
      else if (isDue(c)) due.push(c);
    }
  due.sort((x, y) => x.due - y.due);
  queue = [...due, ...fresh.slice(0, newLeft())];   // daily new-card limit (Settings)
  show("study");
  nextCard();
}
function nextCard() {
  $("study-done").hidden = true;
  if (!queue.length) {
    current = null;
    $("flashcard").hidden = $("show-wrap").hidden = $("rate-wrap").hidden = true;
    $("study-progress").textContent = "";
    $("play-btn").hidden = true;
    $("study-done").hidden = false;
    return;
  }
  current = queue[0];
  $("flashcard").hidden = false;
  $("flashcard").classList.remove("back");
  $("card-text").textContent = current.front;
  $("show-wrap").hidden = false;
  $("rate-wrap").hidden = true;
  $("study-progress").textContent = `${queue.length} cards left`;
  $("play-btn").hidden = !(current.aq || current.aa);
  playAudio(current.aq);
  const nx = queue[1];
  if (nx) audioPrefetch([...(nx.aq || []), ...(nx.aa || [])]);   // download the next card's audio ahead of time
}
function reveal() {
  if (!current || !$("rate-wrap").hidden) return;
  playAudio(current.aa);
  $("flashcard").classList.add("back");
  $("card-text").textContent = current.back;
  $("show-wrap").hidden = true;
  $("rate-wrap").hidden = false;
  for (const r of ["again", "hard", "good", "easy"]) $("t-" + r).textContent = label(current, r);
}
function rate(rating) {
  if (!current || $("rate-wrap").hidden) return;
  if (isNew(current)) addNewDone();
  Object.assign(current, schedule(current, rating));
  queue.shift();
  if (rating === "again") queue.push(current); // show again in this session
  enqueue("card", current.id);
  nextCard();
}

/* ---------- Events ---------- */
$("back-btn").addEventListener("click", () => renderDecks());
$("browse-back").addEventListener("click", () => renderDecks(parentPath(browsePath)));
$("folder-study").addEventListener("click", () => startStudy(decksUnder(browsePath), { folder: browsePath }));
$("exit-study-btn").addEventListener("click", () => {
  playAudio();
  if (studyFrom?.deck && deckById(studyFrom.deck)) renderDeck(studyFrom.deck);
  else renderDecks(studyFrom?.folder ?? browsePath);
});
$("play-btn").addEventListener("click", () => {
  if (!current) return;
  const back = $("flashcard").classList.contains("back");
  playAudio(back && current.aa?.length ? current.aa : current.aq, true);
});

$("deck-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("deck-name").value.trim();
  if (!name) return;
  const nd = { id: uid(), name: browsePath ? browsePath + SEP + name : name, cards: [] };
  state.decks.push(nd);
  enqueue("deck", nd.id);
  e.target.reset();
  renderDecks();
});
$("card-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const front = $("card-front").value.trim();
  const back = $("card-back").value.trim();
  if (!front || !back) return;
  const nc = newCard(front, back);
  deckById(currentDeckId).cards.push(nc);
  enqueue("card", nc.id);
  e.target.reset();
  renderDeck(currentDeckId, 1e9);   // jump to the last page, where the new card is
  $("card-front").focus();
});
$("delete-deck-btn").addEventListener("click", () => {
  const d = deckById(currentDeckId);
  if (confirm(`Delete the deck "${d.name}"?`)) {
    state.decks = state.decks.filter((x) => x.id !== d.id);
    enqueue("delDeck", d.id);
    renderDecks();
  }
});
$("study-btn").addEventListener("click", () => startStudy([deckById(currentDeckId)], { deck: currentDeckId }));
$("show-btn").addEventListener("click", reveal);
$("flashcard").addEventListener("click", reveal);
document.querySelectorAll("[data-rating]").forEach((b) =>
  b.addEventListener("click", () => rate(b.dataset.rating))
);

// Shortcuts: Space = show answer, 1–4 = rate
document.addEventListener("keydown", (e) => {
  if ($("view-study").hidden || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); reveal(); }
  const map = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
  if (map[e.key]) rate(map[e.key]);
});

/* ---------- Export / import ---------- */
$("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ decks: state.decks }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kartyatar-mentes.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (/\.(apkg|zip)$/i.test(file.name)) {
    e.target.value = "";
    return openApkg(file);
  }
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.decks)) throw new Error();
    // Merge: new decks are added, existing decks only get their missing cards
    let added = 0;
    for (const nd of data.decks) {
      if (!nd.id || !nd.name || !Array.isArray(nd.cards)) continue;
      let deck = deckById(nd.id);
      if (!deck) {
        deck = { id: nd.id, name: nd.name, cards: [] };
        state.decks.push(deck);
        state.pending.push({ type: "deck", id: deck.id });
      }
      const have = new Set(deck.cards.map((c) => c.id));
      for (const c of nd.cards) {
        if (!c.id || have.has(c.id) || !c.front || !c.back) continue;
        deck.cards.push({ ease: 2.5, interval: 0, reps: 0, due: 0, ...c });
        state.pending.push({ type: "card", id: c.id });
        added++;
      }
    }
    save();
    flush();
    renderDecks();
    alert(`Imported ${added} new cards.`);
  } catch {
    alert("This file is not a valid backup.");
  }
  e.target.value = "";
});

/* ---------- Account ---------- */
$("login-btn").addEventListener("click", login);
$("logout-btn").addEventListener("click", async () => {
  await flush();
  saveSession(null);
  state = { decks: [], pending: [] }; // keep different accounts' data separate
  save();
  showLogin();
});

readHash();
saveSession(session);
if (session) { renderDecks(); syncInit(); } else showLogin();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Autoplay setting (Settings tab)
$("autoplay").checked = localStorage.getItem("flashcards-autoplay") !== "off";
$("autoplay").addEventListener("change", (e) => localStorage.setItem("flashcards-autoplay", e.target.checked ? "on" : "off"));

// New cards per day (Settings)
$("new-per-day").value = newLimit();
$("new-per-day").addEventListener("change", (e) => {
  localStorage.setItem("flashcards-newperday", Math.max(0, +e.target.value || 0));
  e.target.value = newLimit();
});
