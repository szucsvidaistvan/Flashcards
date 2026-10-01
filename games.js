"use strict";
/* Games: practice with the cards of the selected deck (they do not affect scheduling) */
let gDeckId = null;
const area = $("game-area");
const shuffle = (a) => [...a].sort(() => Math.random() - 0.5);
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const setScore = (t) => ($("game-score").textContent = t);
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = localStorage.getItem("kartyatar-lang") || "en-US";
  speechSynthesis.speak(u);
}
function finish(title, detail, again) {
  area.innerHTML = "";
  const box = h("div", "result");
  const a = h("button", null, "Play again");
  a.onclick = again;
  const b = h("button", "ghost", "Back to games");
  b.onclick = renderGames;
  box.append(h("h2", null, title), h("p", "muted", detail), a, b);
  area.append(box);
  setScore("");
}

/* 1) Match */
function playMatch(cards, again) {
  const set = shuffle(cards).slice(0, 6);
  let sel = null, left = set.length, wrong = 0;
  area.innerHTML = "";
  setScore("");
  const grid = h("div", "match-grid"), L = h("div", "match-col"), R = h("div", "match-col");
  const mk = (txt, id, side) => { const b = h("button", "tile", txt); b.dataset.id = id; b.dataset.side = side; return b; };
  shuffle(set).forEach((c) => L.append(mk(c.front, c.id, "l")));
  shuffle(set).forEach((c) => R.append(mk(c.back, c.id, "r")));
  grid.append(L, R);
  area.append(grid);
  grid.addEventListener("click", (e) => {
    const b = e.target.closest(".tile");
    if (!b || b.disabled) return;
    if (!sel || sel.dataset.side === b.dataset.side) {
      sel?.classList.remove("sel");
      sel = b;
      b.classList.add("sel");
    } else if (sel.dataset.id === b.dataset.id) {
      for (const x of [sel, b]) { x.classList.remove("sel"); x.classList.add("ok"); x.disabled = true; }
      sel = null;
      if (--left === 0) setTimeout(() => finish("Done!", `${wrong} mistake${wrong === 1 ? "" : "s"}`, again), 500);
    } else {
      wrong++;
      const pair = [sel, b];
      sel = null;
      pair.forEach((x) => x.classList.add("bad"));
      setTimeout(() => pair.forEach((x) => x.classList.remove("bad", "sel")), 450);
    }
  });
}

/* 2) Quiz and 3) Audio quiz */
function playQuiz(cards, audio, again) {
  const qs = shuffle(cards).slice(0, 10);
  let i = 0, score = 0;
  const next = () => {
    if (i >= qs.length) return finish("Result", `${score} / ${qs.length} correct`, again);
    const c = qs[i];
    setScore(`${i + 1} / ${qs.length}`);
    area.innerHTML = "";
    const q = h("div", "question", audio ? "🔊" : c.front);
    if (audio) {
      q.classList.add("audio");
      q.setAttribute("role", "button");
      q.setAttribute("aria-label", "Play the word");
      q.onclick = () => speak(c.front);
      speak(c.front);
    }
    const opts = h("div", "options");
    const wrongs = shuffle(cards.filter((x) => x.id !== c.id && x.back !== c.back)).slice(0, 3);
    shuffle([c, ...wrongs]).forEach((o) => {
      const b = h("button", "opt", o.back);
      b.onclick = () => {
        opts.querySelectorAll("button").forEach((x) => (x.disabled = true));
        if (o.id === c.id) { b.classList.add("ok"); score++; }
        else {
          b.classList.add("bad");
          [...opts.children].find((x) => x.textContent === c.back)?.classList.add("ok");
        }
        i++;
        setTimeout(next, 900);
      };
      opts.append(b);
    });
    area.append(q, opts);
    if (audio) area.append(h("p", "muted", "Tap the speaker to hear it again."));
  };
  next();
}

/* 4) Anagram */
function playAnagram(cards, again) {
  const words = shuffle(cards.filter((c) => c.front.replace(/\s/g, "").length > 1)).slice(0, 8);
  if (!words.length) return finish("No suitable words", "You need cards with at least 2 letters on the front.", renderGames);
  let i = 0, score = 0;
  const next = () => {
    if (i >= words.length) return finish("Result", `${score} / ${words.length} words`, again);
    const c = words[i];
    setScore(`${i + 1} / ${words.length}`);
    const target = [...c.front.replace(/\s/g, "")];
    let pool = shuffle(target.map((ch) => ({ ch, used: false })));
    for (let t = 0; t < 10 && pool.map((p) => p.ch).join("") === target.join(""); t++) pool = shuffle(pool);
    const picked = [];
    const slots = h("div", "letters slots"), bank = h("div", "letters");
    const draw = () => {
      slots.innerHTML = bank.innerHTML = "";
      picked.forEach((p, idx) => {
        const b = h("button", "tile letter", p.ch);
        b.onclick = () => { picked.splice(idx, 1); p.used = false; draw(); };
        slots.append(b);
      });
      pool.forEach((p) => {
        const b = h("button", "tile letter", p.ch);
        b.disabled = p.used;
        b.onclick = () => { p.used = true; picked.push(p); draw(); check(); };
        bank.append(b);
      });
    };
    const check = () => {
      if (picked.length !== target.length) return;
      const ok = picked.map((p) => p.ch).join("").toLowerCase() === target.join("").toLowerCase();
      slots.classList.add(ok ? "ok" : "bad");
      if (ok) { score++; i++; setTimeout(next, 800); }
      else setTimeout(() => { slots.classList.remove("bad"); picked.splice(0).forEach((p) => (p.used = false)); draw(); }, 700);
    };
    const skip = h("button", "ghost", "Skip");
    skip.onclick = () => { i++; next(); };
    area.innerHTML = "";
    area.append(h("div", "question", c.back), slots, bank, skip);
    draw();
  };
  next();
}

/* 5) Typing */
function playType(cards, again) {
  const qs = shuffle(cards).slice(0, 10);
  let i = 0, score = 0;
  const next = () => {
    if (i >= qs.length) return finish("Result", `${score} / ${qs.length} correct`, again);
    const c = qs[i];
    setScore(`${i + 1} / ${qs.length}`);
    const inp = h("input");
    Object.assign(inp, { placeholder: "Type the word…", autocomplete: "off", autocapitalize: "off", spellcheck: false });
    const fb = h("p", "feedback"), btn = h("button", null, "Check");
    let done = false;
    const submit = () => {
      if (done) { i++; return next(); }
      done = true;
      const ok = inp.value.trim().toLowerCase() === c.front.trim().toLowerCase();
      if (ok) score++;
      fb.textContent = ok ? "Correct!" : "Correct answer: " + c.front;
      fb.className = "feedback " + (ok ? "ok" : "bad");
      inp.disabled = true;
      btn.textContent = "Next";
      btn.focus();
    };
    btn.onclick = submit;
    inp.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    area.innerHTML = "";
    area.append(h("div", "question", c.back), inp, fb, btn);
    inp.focus();
  };
  next();
}

/* Game list */
const GAMES = [
  { icon: "🧩", color: "#e0a21b", name: "Match", desc: "Match the fronts to the backs", min: 3, run: playMatch },
  { icon: "❓", color: "#3b9bff", name: "Quiz", desc: "Choose the correct meaning", min: 4, run: (c, a) => playQuiz(c, false, a) },
  { icon: "🎧", color: "#ef4a5f", name: "Audio quiz", desc: "Listen to the word and pick its meaning", min: 4, run: (c, a) => playQuiz(c, true, a) },
  { icon: "🔤", color: "#34b27b", name: "Anagram", desc: "Unscramble the word from its letters", min: 1, run: playAnagram },
  { icon: "⌨️", color: "#8a5cf0", name: "Typing", desc: "Type the word from its meaning", min: 1, run: playType },
];

function startGame(g) {
  const d = deckById(gDeckId);
  if (!d || d.cards.length < g.min) {
    $("games-msg").textContent = d ? `You need at least ${g.min} cards in this deck.` : "Create a deck first.";
    return;
  }
  $("games-msg").textContent = "";
  show("game");
  $("game-title").textContent = g.name;
  const go = () => g.run(d.cards, go);
  go();
}

function renderGames() {
  window.speechSynthesis?.cancel();
  show("games");
  const sel = $("games-deck");
  sel.innerHTML = "";
  state.decks.forEach((d) => { const o = h("option", null, `${d.name} (${d.cards.length})`); o.value = d.id; sel.append(o); });
  if (!deckById(gDeckId)) gDeckId = state.decks[0]?.id;
  sel.value = gDeckId || "";
  $("games-msg").textContent = state.decks.length ? "" : "Create a deck first in the Cards tab.";
  const list = $("game-list");
  list.innerHTML = "";
  for (const g of GAMES) {
    const li = h("li"), b = h("button"), ic = h("span", "g-ic", g.icon), t = h("span");
    ic.style.background = g.color + "33";
    t.append(h("span", "g-name", g.name), h("span", "g-desc", g.desc));
    b.append(ic, t);
    b.onclick = () => startGame(g);
    li.append(b);
    list.append(li);
  }
}

document.querySelectorAll(".tabbar button").forEach((b) =>
  b.addEventListener("click", () => {
    const t = b.dataset.tab;
    if (t === "decks") renderDecks();
    else if (t === "games") renderGames();
    else show("settings");
  })
);
$("games-deck").addEventListener("change", (e) => (gDeckId = e.target.value));
$("exit-game-btn").addEventListener("click", renderGames);
$("lang-select").value = localStorage.getItem("kartyatar-lang") || "en-US";
$("lang-select").addEventListener("change", (e) => localStorage.setItem("kartyatar-lang", e.target.value));
