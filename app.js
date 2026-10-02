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
let editingCardId = null;

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

// How many cards one press of "Study" gives you (Settings)
function sessionSize() {
  const v = localStorage.getItem("flashcards-session");
  return v === null ? 20 : Math.max(1, +v || 20);
}

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
  // the jsonb column "audio" also carries the pronunciation text (ipa)
  ...(c.aq || c.aa || c.ipa ? { audio: { q: c.aq || [], a: c.aa || [], ipa: c.ipa || "" } } : {}),
});
const fromRow = (r) => withAudio(r, {
  id: r.id, front: r.front, back: r.back,
  ease: r.ease, interval: r.interval_days, reps: r.reps, due: Number(r.due),
});
function withAudio(r, card) {
  if (r.audio?.q?.length) card.aq = r.audio.q;
  if (r.audio?.a?.length) card.aa = r.audio.a;
  if (r.audio?.ipa) card.ipa = r.audio.ipa;
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
const cardCount = (decks) => decks.reduce((n, d) => n + d.cards.length, 0);
const countsHtml = (n) => `<span class="counts">${n} ${n === 1 ? "card" : "cards"}</span>`;

function cardMatchesQuery(card, query) {
  if (!query) return true;
  return [card.front, card.back, card.ipa || ""].some((value) => String(value).toLowerCase().includes(query));
}

function setCardFormMode(card = null) {
  const form = $("card-form");
  const title = $("card-form-title");
  const cancel = $("card-cancel-edit");
  const submit = $("card-submit-btn");
  if (!card) {
    editingCardId = null;
    form.reset();
    title.textContent = "Add card";
    cancel.hidden = true;
    submit.textContent = "Add card";
    return;
  }
  editingCardId = card.id;
  $("card-edit-id").value = card.id;
  $("card-front").value = card.front;
  $("card-back").value = card.back;
  title.textContent = "Edit card";
  cancel.hidden = false;
  submit.textContent = "Save changes";
}

// Cards tab: shows the folders / decks inside browsePath, like the Anki deck list
function renderDecks(path = browsePath) {
  while (path && !decksUnder(path).length) path = parentPath(path);   // folder disappeared
  browsePath = path;
  currentDeckId = null;
  setCardFormMode();
  show("decks");
  const inside = path !== "";
  $("browse-back").hidden = !inside;
  $("decks-title").textContent = inside ? lastSeg(path) : "Cards";
  $("browse-path").textContent = path.split(SEP).join(" › ");
  $("folder-study").hidden = !inside;
  $("folder-study").textContent = "Study this folder";

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
  if (own) addRow("Cards in this deck", cardCount([own]), false, () => renderDeck(own.id));
  [...kids.values()].sort((x, y) => natural(x.seg, y.seg)).forEach((k) => {
    const open = k.folder ? () => renderDecks(k.path) : () => renderDeck(k.deck.id);
    addRow(k.seg, cardCount(decksUnder(k.path)), k.folder, open);
  });
  if (!list.children.length) list.innerHTML = '<li class="empty">No decks yet. Create your first one above.</li>';
}

function renderDeck(id, page = 0) {
  currentDeckId = id;
  const d = deckById(id);
  show("deck");
  $("deck-title").textContent = lastSeg(d.name);
  $("deck-path").textContent = parentPath(d.name).split(SEP).join(" › ");

  const search = $("deck-search")?.value.trim().toLowerCase() || "";
  const filtered = d.cards.filter((card) => cardMatchesQuery(card, search));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cardPage = Math.min(page, pages - 1);
  const from = cardPage * PAGE;
  const slice = filtered.slice(from, from + PAGE);
  $("deck-stats").textContent = `${filtered.length} / ${d.cards.length} cards`;
  $("pager").hidden = filtered.length <= PAGE;
  $("pager-info").textContent = filtered.length ? `${from + 1}–${from + slice.length} of ${filtered.length}` : "0 cards";
  $("page-prev").disabled = cardPage === 0;
  $("page-next").disabled = cardPage >= pages - 1;
  $("page-prev").onclick = () => renderDeck(id, cardPage - 1);
  $("page-next").onclick = () => renderDeck(id, cardPage + 1);

  const list = $("card-list");
  list.innerHTML = "";
  if (!filtered.length) list.innerHTML = '<li class="empty">No cards match this search.</li>';
  for (const card of slice) {
    const li = document.createElement("li");
    li.className = "card-row";
    const a = document.createElement("span");
    const b = document.createElement("span");
    a.textContent = card.front;
    b.textContent = card.back;
    const audioBtn = document.createElement("button");
    audioBtn.type = "button";
    audioBtn.className = "small ghost card-audio";
    audioBtn.textContent = "🔊";
    audioBtn.title = "Play audio";
    audioBtn.hidden = !(card.aq || card.aa);
    audioBtn.addEventListener("click", (e) => { e.stopPropagation(); playAudio(card.aq?.length ? card.aq : card.aa, true); });
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "small ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); setCardFormMode(card); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger small";
    del.textContent = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      d.cards = d.cards.filter((x) => x.id !== card.id);
      enqueue("delCard", card.id);
      renderDeck(id, cardPage);
    });
    li.append(a, b, audioBtn, editBtn, del);
    list.append(li);
  }
}

/* ---------- Study ---------- */
let lastScope = [], studySize = 0;
// "Study" works any time: due cards first, then new cards, then the ones due soonest (review ahead)
function startStudy(scope, from) {
  studyFrom = from;
  lastScope = scope;
  const due = [], fresh = [], ahead = [];
  for (const d of [...scope].sort((x, y) => natural(x.name, y.name)))
    for (const c of d.cards) {
      if (isNew(c)) fresh.push(c);
      else if (isDue(c)) due.push(c);
      else ahead.push(c);
    }
  due.sort((x, y) => x.due - y.due);
  ahead.sort((x, y) => x.due - y.due);
  queue = [...due, ...fresh, ...ahead].slice(0, sessionSize());
  studySize = queue.length;
  show("study");
  nextCard();
}
/* ---------- Card faces ---------- */
let ipaShown = false;
const autoIpa = () => false;
const POS = /^[a-z]{1,8}\.(\s|$)/i;   // part-of-speech tag at the start: "n.", "adj.", "pro."
const splitPos = (t) => { const m = t.match(/^([a-z]{1,8}\.)\s+([\s\S]+)$/i); return m ? { pos: m[1], text: m[2] } : { pos: "", text: t }; };

// A "word card" has a pronunciation, and one side is the meaning (starts with a part-of-speech tag)
function wordInfo(c) {
  if (!c.ipa) return null;
  if (POS.test(c.back)) return { word: c.front, meaning: c.back, frontIsWord: true };
  if (POS.test(c.front)) return { word: c.back, meaning: c.front, frontIsWord: false };
  return null;
}
const audioFor = (c, side) => (side === "back" && c.aa?.length ? c.aa : c.aq);

function renderFace(side) {
  const face = $("card-face"), c = current, w = wordInfo(c);
  face.innerHTML = "";
  if (!w) {
    face.append(h("p", "plain", side === "front" ? c.front : c.back));
    if (ipaShown && c.ipa) face.append(h("div", "w-notes", c.ipa));
    return;
  }
  const [ipaLine, ...notes] = c.ipa.split("\n");
  const showWord = side === "back" || w.frontIsWord;
  const showMeaning = side === "back" || !w.frontIsWord;
  if (showWord) {
    face.append(h("div", "w-word", w.word));
    if (ipaShown) face.append(h("div", "w-ipa", ipaLine));
  }
  if (side === "back" && (c.aq || c.aa)) {
    const p = h("button", "w-play", "▶");
    p.setAttribute("aria-label", "Play audio");
    p.onclick = (e) => { e.stopPropagation(); playAudio(audioFor(c, side), true); };
    face.append(p);
  }
  if (showWord && showMeaning) face.append(h("hr", "w-line"));
  if (showMeaning) {
    const { pos, text } = splitPos(w.meaning), row = h("div", "w-mean");
    if (pos) row.append(h("span", "w-pos", pos));
    row.append(h("span", "w-text", text));
    face.append(row);
  }
  if (ipaShown && side === "back" && notes.length) face.append(h("div", "w-notes", notes.join("\n")));
}
function updateIpaBtn() {
  const b = $("ipa-btn");
  b.hidden = !current?.ipa;
  b.textContent = ipaShown ? "Hide" : "Pronunciation";
}

function nextCard() {
  $("study-done").hidden = true;
  $("more-wrap").hidden = true;
  if (!queue.length) {
    current = null;
    $("flashcard").hidden = $("show-wrap").hidden = $("rate-wrap").hidden = true;
    $("study-progress").textContent = "";
    $("play-btn").hidden = $("ipa-btn").hidden = true;
    $("study-done").textContent = studySize ? "Session complete!" : "This deck has no cards yet.";
    $("study-done").hidden = false;
    $("more-wrap").hidden = !studySize;
    return;
  }
  current = queue[0];
  ipaShown = false;
  $("flashcard").hidden = false;
  $("flashcard").classList.remove("back");
  renderFace("front");
  $("show-wrap").hidden = false;
  $("rate-wrap").hidden = true;
  $("study-progress").textContent = `${queue.length} left`;
  $("play-btn").hidden = !(current.aq || current.aa);
  updateIpaBtn();
  playAudio(current.aq);
  const nx = queue[1];
  if (nx) audioPrefetch([...(nx.aq || []), ...(nx.aa || [])]);   // download the next card's audio ahead of time
}
function reveal() {
  if (!current || !$("rate-wrap").hidden) return;
  playAudio(current.aa);
  $("flashcard").classList.add("back");
  renderFace("back");
  updateIpaBtn();
  if (wordInfo(current)) $("play-btn").hidden = true;   // the word layout has its own play button
  $("show-wrap").hidden = true;
  $("rate-wrap").hidden = false;
}
function rate(rating) {
  if (!current || $("rate-wrap").hidden) return;
  if (rating === "next") {
    queue.shift();
    enqueue("card", current.id);
    nextCard();
    return;
  }
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
$("ipa-btn").addEventListener("click", () => {
  if (!current) return;
  ipaShown = !ipaShown;
  renderFace($("flashcard").classList.contains("back") ? "back" : "front");
  updateIpaBtn();
});
$("more-btn").addEventListener("click", () => startStudy(lastScope, studyFrom));
$("play-btn").addEventListener("click", () => {
  if (!current) return;
  const back = $("flashcard").classList.contains("back");
  playAudio(back && current.aa?.length ? current.aa : current.aq, true);
});

$("deck-search").addEventListener("input", () => {
  if (currentDeckId) renderDeck(currentDeckId, 0);
});
$("deck-search-clear").addEventListener("click", () => {
  $("deck-search").value = "";
  if (currentDeckId) renderDeck(currentDeckId, 0);
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
  if (!front || !back || !currentDeckId) return;
  const deck = deckById(currentDeckId);
  if (!deck) return;
  if (editingCardId) {
    const card = deck.cards.find((c) => c.id === editingCardId);
    if (!card) return;
    card.front = front;
    card.back = back;
    enqueue("card", card.id);
    setCardFormMode();
    renderDeck(currentDeckId, 0);
    return;
  }
  const nc = newCard(front, back);
  deck.cards.push(nc);
  enqueue("card", nc.id);
  e.target.reset();
  renderDeck(currentDeckId, 1e9);   // jump to the last page, where the new card is
  $("card-front").focus();
});
$("card-cancel-edit").addEventListener("click", () => setCardFormMode());
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

// Shortcuts: Space = show answer, Enter = next, 1–4 = rate
 document.addEventListener("keydown", (e) => {
   if ($("view-study").hidden || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
   if (e.code === "Space") { e.preventDefault(); reveal(); }
   if (e.code === "Enter" && !$("rate-wrap").hidden) { e.preventDefault(); rate("next"); }
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

// Cards per study session (Settings)
$("session-size").value = sessionSize();
$("session-size").addEventListener("change", (e) => {
  localStorage.setItem("flashcards-session", Math.max(1, +e.target.value || 20));
  e.target.value = sessionSize();
});

// No pinch or double-tap zoom: the app should feel native
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });





























































































































































































































































































































































































































































































































































































































