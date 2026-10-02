"use strict";
/* Anki .apkg import: reads the package in the browser (JSZip + sql.js), turns notes into
   front/back text cards and stores the audio files on this device. */

/* ---------- Text helpers (pure functions, no DOM) ---------- */
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENT[e.toLowerCase()] ?? m;
  });

// Removes whole elements (including nested children) whose opening tag matches openRe
function removeBlocks(s, openRe) {
  let m;
  while ((m = openRe.exec(s))) {
    const tag = m[1].toLowerCase(), start = m.index;
    const tok = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    tok.lastIndex = start + m[0].length;
    let depth = 1, end = s.length, t;
    while ((t = tok.exec(s))) {
      depth += t[1] ? -1 : 1;
      if (!depth) { end = tok.lastIndex; break; }
    }
    s = s.slice(0, start) + s.slice(end);
  }
  return s;
}

// HTML (as produced by an Anki card template) -> { text, sounds }
function toText(html, maxLen = 800) {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  // Elements that the template hides with CSS rules (#id { visibility:hidden })
  const hiddenIds = [];
  s.replace(/<style[\s\S]*?<\/style>/gi, (css) => {
    css.replace(/([^{}]+)\{([^}]*)\}/g, (m, sel, body) => {
      if (/visibility\s*:\s*hidden|display\s*:\s*none/i.test(body)) sel.replace(/#([\w-]+)/g, (x, id) => hiddenIds.push(id));
    });
  });
  s = s.replace(/<(style|script|button)\b[\s\S]*?<\/\1>/gi, "");
  s = removeBlocks(s, /<(div|span|table|section)\b[^>]*(display\s*:\s*none|visibility\s*:\s*hidden|onmouse(over|enter))[^>]*>/i);
  for (const id of hiddenIds) s = removeBlocks(s, new RegExp(`<(div|span|table|section)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"));
  const sounds = [];
  s = s.replace(/\[sound:([^\]]+)\]/g, (m, n) => { if (!sounds.includes(n)) sounds.push(n); return ""; });
  s = s.replace(/<(?:br|p|div|\/div|\/p|\/tr|\/h\d|\/li)(?=[\s>\/])[^>]*>/gi, "\n").replace(/<\/t[hd]>/gi, " | ").replace(/<[^>]+>/g, "");
  s = s.replace(/\[audio\]/gi, "");
  const lines = decode(s).replace(/\u00a0/g, " ").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim().replace(/\|$/, "").trim());
  let text = lines.filter(Boolean).join("\n");
  if (text.length > maxLen) text = text.slice(0, maxLen).trimEnd() + "…";
  return { text, sounds };
}

// Mustache-like Anki templates: {{Field}}, {{FrontSide}}, {{#Field}}..{{/Field}}, {{^Field}}..{{/Field}}
function renderTpl(tpl, f, front) {
  let s = tpl;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (m, kind, name, inner) => {
      const has = !!toText(f[name] || "", 5).text || /\[sound:/.test(f[name] || "");
      return (kind === "#") === has ? inner : "";
    });
    if (next === s) break;
    s = next;
  }
  return s.replace(/\{\{([^}]+)\}\}/g, (m, raw) => {
    const parts = raw.split(":").map((x) => x.trim());
    const name = parts.pop();
    if (name === "FrontSide") return front;
    if (parts[0] === "type") return "";
    return f[name] ?? "";
  });
}

function cloze(text, ord, hide) {
  return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, (m, n, t) => (hide && +n - 1 === ord ? "[…]" : t));
}

const IPA_CHARS = /[\u0250-\u02FF\u0300-\u036F\u1D00-\u1DBF]/;   // IPA letters, modifiers, combining marks
const LEAD_ARTICLE = /^(?:\S{1,3}\s+|\S{1,2}['’])/;               // "la ", "les ", "l'"
const norm = (t) => t.normalize("NFC").trim().toLowerCase();

// One Anki card -> { front, back, ipa?, aq?, aa? }
//   aq / aa = audio files of the question / answer side
//   ipa     = pronunciation and grammar notes, shown only when the learner asks for them
function makeCard(model, flds, ord) {
  const vals = flds.split("\x1f");
  const f = {};
  model.flds.forEach((fl, i) => (f[fl.name] = vals[i] || ""));

  const render = (fields) => {
    if (model.type === 1) {
      const text = fields.Text ?? vals[0];
      return { qh: cloze(text, ord, true), ah: cloze(text, ord, false) + "<br>" + (fields["Back Extra"] ?? fields.Extra ?? "") };
    }
    const t = model.tmpls.find((x) => x.ord === ord) || model.tmpls[0];
    const qh = renderTpl(t.qfmt, fields, "");
    let ah = renderTpl(t.afmt, fields, qh);
    const parts = ah.split(/<hr\s+id=["']?answer["']?\s*\/?>/i);
    if (parts.length > 1) ah = parts.pop();
    return { qh, ah };
  };
  // Answer lines, without the lines that only repeat the question
  const answerLines = (aText, qText) => {
    const qLines = new Set(qText.split("\n"));
    const kept = aText.split("\n").filter((l) => !qLines.has(l));
    return kept.length ? kept : aText.split("\n");
  };

  const { qh, ah } = render(f);
  const q = toText(qh), a = toText(ah);
  const card = { front: q.text || (q.sounds.length ? "🔊" : ""), back: answerLines(a.text, q.text).join("\n") || "(see front)" };
  if (q.sounds.length) card.aq = q.sounds;
  if (a.sounds.length) card.aa = a.sounds;

  // Word cards with an IPA field: keep only the word / meaning on the back, move the pronunciation away
  const ipaNames = model.flds.map((x) => x.name).filter((n) => /ipa|pronunc|phonet/i.test(n) && toText(f[n] || "", 1e6).text);
  if (ipaNames.length && model.type !== 1) {
    const ipaTexts = ipaNames.map((n) => toText(f[n], 1e6).text);
    if (!ipaTexts.some((t) => q.text.includes(t))) {
      const f2 = { ...f };
      ipaNames.forEach((n) => (f2[n] = ""));
      const notes = [];
      const lines = answerLines(toText(render(f2).ah).text, q.text)
        .map((l) => l.replace(/\[([^\]]*)\]/g, (m, inner) => (IPA_CHARS.test(inner) ? m : (notes.push(m), ""))).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const qn = norm(q.text);
      const rest = lines.filter((l) => norm(l) !== qn && norm(l.replace(LEAD_ARTICLE, "")) !== qn);
      if (rest.length) {
        card.back = rest.join("\n");
        const extra = [...ipaTexts, ...notes].filter(Boolean).join("\n");
        if (extra) card.ipa = extra;
      }
    }
  }
  return card;
}

if (typeof module !== "undefined") module.exports = { toText, renderTpl, makeCard, decode };

/* ---------- Browser part ---------- */
if (typeof document !== "undefined") {
  const LIB = { jszip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", sql: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/" };
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src + " (offline?)"));
    document.head.append(s);
  });
  const hash = (str) => { let h = 5381; for (const c of str) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
  const MIME = { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/mp4", flac: "audio/flac", opus: "audio/ogg" };
  let pkg = null;

  async function readApkg(file) {
    if (!window.JSZip) await loadScript(LIB.jszip);
    if (!window.initSqlJs) await loadScript(LIB.sql + "sql-wasm.js");
    const zip = await JSZip.loadAsync(file);
    const dbFile = zip.file("collection.anki21") || zip.file("collection.anki2");
    if (!dbFile) throw new Error(zip.file("collection.anki21b")
      ? 'This is a new-format export. In Anki, export again and tick "Support older Anki versions".'
      : "This does not look like an Anki package.");
    const SQL = await initSqlJs({ locateFile: (f) => LIB.sql + f });
    const db = new SQL.Database(new Uint8Array(await dbFile.async("uint8array")));
    const [models, decks] = db.exec("select models, decks from col")[0].values[0].map(JSON.parse);
    const media = zip.file("media") ? JSON.parse(await zip.file("media").async("string")) : {};
    const counts = {};
    db.exec("select did, count(*) from cards group by did")[0]?.values.forEach(([d, n]) => (counts[d] = n));
    return { zip, db, models, decks, media, counts };
  }

  async function openApkg(file) {
    const list = $("apkg-list"), msg = $("apkg-msg"), btn = $("apkg-import");
    list.innerHTML = ""; btn.disabled = true; msg.textContent = "Reading " + file.name + "…";
    $("apkg-dialog").showModal();
    try {
      pkg = await readApkg(file);
      const ds = Object.values(pkg.decks).filter((d) => pkg.counts[d.id]).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const first = new Set(ds.map((d) => d.name.split("::")[0]));
      for (const d of ds) {
        const segs = d.name.split("::");
        d.label = (first.size === 1 && segs.length > 1 ? segs.slice(1) : segs).slice(-2).join(" › ");
        const row = document.createElement("label");
        row.className = "apkg-row";
        row.innerHTML = '<input type="checkbox"><span></span><small></small>';
        row.firstChild.value = d.id;
        row.children[1].textContent = d.label;
        row.children[2].textContent = pkg.counts[d.id] + " cards";
        list.append(row);
      }
      msg.textContent = ds.length ? "Choose the decks to import:" : "No cards found in this package.";
      btn.disabled = !ds.length;
    } catch (e) {
      console.error(e);
      msg.textContent = "Error: " + e.message;
    }
  }

  async function importSelected() {
    const msg = $("apkg-msg"), btn = $("apkg-import");
    const ids = [...$("apkg-list").querySelectorAll("input:checked")].map((i) => i.value);
    if (!ids.length) return (msg.textContent = "Select at least one deck.");
    btn.disabled = true;
    try {
      const needed = new Set();
      let added = 0, updated = 0;
      for (const did of ids) {
        const info = pkg.decks[did];
        const deckId = "ak-" + hash(info.name);
        let deck = deckById(deckId);
        if (!deck) {
          deck = { id: deckId, name: info.name, cards: [] };
          state.decks.push(deck);
          state.pending.push({ type: "deck", id: deckId });
        } else if (deck.name !== info.name) {
          deck.name = info.name;   // older imports used shortened names
          state.pending.push({ type: "deck", id: deckId });
        }
        const byId = new Map(deck.cards.map((c) => [c.id, c]));
        const st = pkg.db.prepare("select c.id, c.ord, n.mid, n.flds from cards c join notes n on n.id = c.nid where c.did = ? order by c.due, c.id");
        st.bind([+did]);
        while (st.step()) {
          const r = st.getAsObject(), id = "ak-" + r.id;
          const model = pkg.models[r.mid];
          if (!model) continue;
          const c = makeCard(model, r.flds, r.ord);
          if (!c.front || !c.back) continue;
          const old = byId.get(id);
          if (old) {   // re-import: refresh the text and audio, keep the learning progress
            for (const key of ["aq", "aa", "ipa"]) delete old[key];
            Object.assign(old, c);
            state.pending.push({ type: "card", id });
            updated++;
            continue;
          }
          [...(c.aq || []), ...(c.aa || [])].forEach((n) => needed.add(n));
          deck.cards.push({ id, ease: 2.5, interval: 0, reps: 0, due: 0, ...c });
          state.pending.push({ type: "card", id });
          added++;
        }
        st.free();
        msg.textContent = `Converted ${added} cards…`;
        await new Promise((r) => setTimeout(r));
      }
      // Audio files -> IndexedDB (this device only)
      const rev = {};
      for (const [k, name] of Object.entries(pkg.media)) rev[name] = k;
      const names = [...needed].filter((n) => rev[n]);
      for (let i = 0; i < names.length; i += 40) {
        const batch = await Promise.all(names.slice(i, i + 40).map(async (n) => {
          const buf = await pkg.zip.file(rev[n]).async("arraybuffer");
          return [n, new Blob([buf], { type: MIME[n.split(".").pop().toLowerCase()] || "audio/mpeg" })];
        }));
        await audioPutMany(batch);
        await audioPutMany(batch.map(([n]) => [n, 1]), "queue"); // to be uploaded to Supabase Storage
        msg.textContent = `Saving audio… ${Math.min(i + 40, names.length)} / ${names.length}`;
      }
      save();
      flush();
      renderDecks();
      msg.textContent = `Done: ${added} new and ${updated} updated cards, ${names.length} audio files. The audio uploads in the background – keep the app open until the Settings tab shows "Synced".`;
      pkg = null;
      uploadPending();
      setTimeout(() => $("apkg-dialog").close(), 3500);
    } catch (e) {
      console.error(e);
      msg.textContent = "Error: " + e.message;
      btn.disabled = false;
    }
  }

  window.openApkg = openApkg;
  $("apkg-import").addEventListener("click", importSelected);
  $("apkg-cancel").addEventListener("click", () => { pkg = null; $("apkg-dialog").close(); });
  $("apkg-all").addEventListener("click", () => {
    const boxes = [...$("apkg-list").querySelectorAll("input")];
    const on = boxes.some((b) => !b.checked);
    boxes.forEach((b) => (b.checked = on));
  });
}
