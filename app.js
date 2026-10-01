"use strict";

/* ---------- Adattárolás (localStorage) ---------- */
const STORAGE_KEY = "kartyatar-v1";
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

let state = load();
state.pending ||= []; // még nem szinkronizált műveletek
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const $ = (id) => document.getElementById(id);
const deckById = (id) => state.decks.find((d) => d.id === id);

/* ---------- Supabase szinkron (nincs auth, egyetlen felhasználó) ---------- */
const CFG_KEY = "kartyatar-supabase";
const cfg = window.DEFAULT_SUPABASE; // fix Supabase projekt (config.js)

/* ---------- Google belépés (Supabase Auth, implicit flow) ---------- */
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
  if (!res.ok) { saveSession(null); showLogin(); throw new Error("Lejárt munkamenet"); }
  const t = await res.json();
  saveSession({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, email: session.email });
}
function showLogin() {
  show("login");
  $("login-error").textContent = authError;
}
function login() {
  const back = encodeURIComponent(location.origin + location.pathname);
  location.href = `${cfg.url}/auth/v1/authorize?provider=google&redirect_to=${back}`;
}
let flushing = false;

const setStatus = (t) => ($("sync-status").textContent = t);
const toRow = (c, deckId) => ({
  id: c.id, deck_id: deckId, front: c.front, back: c.back,
  ease: c.ease, interval_days: c.interval, reps: c.reps, due: c.due,
});
const fromRow = (r) => ({
  id: r.id, front: r.front, back: r.back,
  ease: r.ease, interval: r.interval_days, reps: r.reps, due: Number(r.due),
});

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

// Minden változtatás egy sorba kerül, és sorrendben kerül fel a szerverre.
// Ha nincs net, a sor megmarad, és később folytatódik.
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
      const eid = encodeURIComponent(op.id);
      if (op.type === "deck") {
        const d = deckById(op.id);
        if (d) await api("decks?on_conflict=id", "POST", { id: d.id, name: d.name });
      } else if (op.type === "card") {
        for (const d of state.decks) {
          const c = d.cards.find((x) => x.id === op.id);
          if (c) { await api("cards?on_conflict=id", "POST", toRow(c, d.id)); break; }
        }
      } else if (op.type === "delDeck") await api("decks?id=eq." + eid, "DELETE");
      else await api("cards?id=eq." + eid, "DELETE");
      state.pending.shift();
      save();
    }
    setStatus("Szinkronizálva");
  } catch (e) {
    console.error(e);
    setStatus("Nincs kapcsolat – később újrapróbálja");
  }
  flushing = false;
}

async function pull() {
  const [decks, cards] = await Promise.all([
    api("decks?select=*&order=created_at"),
    api("cards?select=*&order=created_at"),
  ]);
  if (!decks.length && state.decks.length) {
    // Első indulás: a meglévő helyi adatok feltöltése
    for (const d of state.decks) state.pending.push({ type: "deck", id: d.id });
    for (const d of state.decks) for (const c of d.cards) state.pending.push({ type: "card", id: c.id });
    save();
    await flush();
    return;
  }
  state.decks = decks.map((d) => ({
    id: d.id, name: d.name,
    cards: cards.filter((c) => c.deck_id === d.id).map(fromRow),
  }));
  save();
}

async function syncInit() {
  if (!session) return showLogin();
  setStatus("Szinkronizálás…");
  await flush();
  if (state.pending.length) return;
  try {
    await pull();
    setStatus("Szinkronizálva");
  } catch (e) {
    console.error(e);
    setStatus("Nincs kapcsolat");
  }
  renderDecks();
}
window.addEventListener("online", syncInit);

/* ---------- Ütemezés (egyszerűsített SM-2) ---------- */
function newCard(front, back) {
  return { id: uid(), front, back, ease: 2.5, interval: 0, reps: 0, due: 0 };
}
const isNew = (c) => c.reps === 0 && c.due === 0;
const isDue = (c) => c.due <= Date.now();

// Visszaadja az új állapotot, ugyanezt használja az előnézet is a gombok alatt
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
  if (rating === "again") return "1 perc";
  return s.interval === 1 ? "1 nap" : s.interval + " nap";
}

/* ---------- Nézetek ---------- */
function show(view) {
  for (const v of ["login", "decks", "deck", "study", "games", "game", "settings"]) $("view-" + v).hidden = v !== view;
  const tab = { decks: "decks", deck: "decks", games: "games", settings: "settings" }[view];
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.body.classList.toggle("immersive", view === "study" || view === "game" || view === "login");
  window.scrollTo(0, 0);
}
function renderDecks() {
  show("decks");
  currentDeckId = null;
  const list = $("deck-list");
  list.innerHTML = "";
  if (!state.decks.length) {
    list.innerHTML = '<li class="empty">Még nincs paklid. Hozd létre az elsőt fent.</li>';
    return;
  }
  for (const d of state.decks) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    const n = d.cards.filter(isNew).length;
    const due = d.cards.filter((c) => !isNew(c) && isDue(c)).length;
    li.innerHTML = `<span class="deck-name"></span>
      <span class="counts"><span class="c-new">${n} új</span><span class="c-due">${due} esedékes</span></span>`;
    li.querySelector(".deck-name").textContent = d.name;
    const open = () => renderDeck(d.id);
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => e.key === "Enter" && open());
    list.append(li);
  }
}
function renderDeck(id) {
  currentDeckId = id;
  const d = deckById(id);
  show("deck");
  $("deck-title").textContent = d.name;
  const n = d.cards.filter(isNew).length;
  const due = d.cards.filter((c) => !isNew(c) && isDue(c)).length;
  $("deck-stats").textContent = `${d.cards.length} kártya · ${n} új · ${due} esedékes`;
  $("study-btn").disabled = n + due === 0;

  const list = $("card-list");
  list.innerHTML = "";
  if (!d.cards.length) list.innerHTML = '<li class="empty">Add hozzá az első kártyát fent.</li>';
  for (const c of d.cards) {
    const li = document.createElement("li");
    const a = document.createElement("span");
    const b = document.createElement("span");
    a.textContent = c.front;
    b.textContent = c.back;
    const del = document.createElement("button");
    del.className = "danger small";
    del.textContent = "Törlés";
    del.addEventListener("click", () => {
      d.cards = d.cards.filter((x) => x.id !== c.id);
      enqueue("delCard", c.id);
      renderDeck(id);
    });
    const tag = document.createElement("span");
    tag.className = "due-tag";
    tag.textContent = isNew(c)
      ? "Új"
      : isDue(c)
      ? "Esedékes"
      : "Következő: " + new Date(c.due).toLocaleDateString("hu-HU");
    li.append(a, b, del, tag);
    list.append(li);
  }
}

/* ---------- Tanulás ---------- */
function startStudy() {
  const d = deckById(currentDeckId);
  const due = d.cards.filter((c) => !isNew(c) && isDue(c));
  const fresh = d.cards.filter(isNew).slice(0, 20); // napi max. 20 új kártya
  queue = [...due, ...fresh];
  show("study");
  nextCard();
}
function nextCard() {
  $("study-done").hidden = true;
  if (!queue.length) {
    current = null;
    $("flashcard").hidden = $("show-wrap").hidden = $("rate-wrap").hidden = true;
    $("study-progress").textContent = "";
    $("study-done").hidden = false;
    return;
  }
  current = queue[0];
  $("flashcard").hidden = false;
  $("flashcard").classList.remove("back");
  $("card-text").textContent = current.front;
  $("show-wrap").hidden = false;
  $("rate-wrap").hidden = true;
  $("study-progress").textContent = `${queue.length} kártya maradt`;
}
function reveal() {
  if (!current || !$("rate-wrap").hidden) return;
  $("flashcard").classList.add("back");
  $("card-text").textContent = current.back;
  $("show-wrap").hidden = true;
  $("rate-wrap").hidden = false;
  for (const r of ["again", "hard", "good", "easy"]) $("t-" + r).textContent = label(current, r);
}
function rate(rating) {
  if (!current || $("rate-wrap").hidden) return;
  Object.assign(current, schedule(current, rating));
  queue.shift();
  if (rating === "again") queue.push(current); // még ebben a körben újra
  enqueue("card", current.id);
  nextCard();
}

/* ---------- Események ---------- */
$("back-btn").addEventListener("click", renderDecks);
$("exit-study-btn").addEventListener("click", () => renderDeck(currentDeckId));

$("deck-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("deck-name").value.trim();
  if (!name) return;
  const nd = { id: uid(), name, cards: [] };
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
  renderDeck(currentDeckId);
  $("card-front").focus();
});
$("delete-deck-btn").addEventListener("click", () => {
  const d = deckById(currentDeckId);
  if (confirm(`Biztosan törlöd a(z) "${d.name}" paklit?`)) {
    state.decks = state.decks.filter((x) => x.id !== d.id);
    enqueue("delDeck", d.id);
    renderDecks();
  }
});
$("study-btn").addEventListener("click", startStudy);
$("show-btn").addEventListener("click", reveal);
$("flashcard").addEventListener("click", reveal);
document.querySelectorAll("[data-rating]").forEach((b) =>
  b.addEventListener("click", () => rate(b.dataset.rating))
);

// Billentyűparancsok: Szóköz = válasz, 1–4 = értékelés
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
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.decks)) throw new Error();
    if (confirm("Ez felülírja a jelenlegi paklikat. Folytatod?")) {
      state = { decks: data.decks, pending: [] };
      for (const d of state.decks) state.pending.push({ type: "deck", id: d.id });
      for (const d of state.decks) for (const c of d.cards) state.pending.push({ type: "card", id: c.id });
      save();
      flush();
      renderDecks();
    }
  } catch {
    alert("A fájl nem érvényes mentés.");
  }
  e.target.value = "";
});

/* ---------- Fiók ---------- */
$("login-btn").addEventListener("click", login);
$("logout-btn").addEventListener("click", async () => {
  await flush();
  saveSession(null);
  state = { decks: [], pending: [] }; // másik fiók adatai ne keveredjenek
  save();
  showLogin();
});

readHash();
saveSession(session);
if (session) { renderDecks(); syncInit(); } else showLogin();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
