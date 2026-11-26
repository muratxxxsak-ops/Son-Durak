import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  runTransaction, writeBatch, serverTimestamp, Timestamp, getCountFromServer, onSnapshot, orderBy, limit
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAIL, TOTAL_SEATS, PLATE, TOTAL_STOPS } from "./config.js";
import { DRAFTS, INTRO } from "./episodes.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

/* ------------------------------------------------------------------ state */
const state = {
  user: null,
  profile: null,
  profileLoaded: false,
  seats: new Map(),          // seatNo -> {uid, nickname}
  seatsLoaded: false,
  episodes: [],              // published episodes, ascending
  episodesLoaded: false,
  myVotes: {},               // epId -> "A"
  counts: {},                // epId -> {A: n, B: n, total}
  picked: null,
  nickDraft: "",
  silentDraft: false,
  busy: false,
  admin: { tab: "bolumler", episodes: null, editing: null, waiting: null, resultFor: null, resultCounts: null },
  chat: { room: null, msgs: [], loaded: false, draft: "", unsub: null, lastSent: 0, sending: false },
  bus: { baggage: [], vanished: [] },   // meta/bus: herkese açık, isimsiz
  myCVotes: {}, cCounts: {}
};

const $app = document.getElementById("app");
const $right = document.getElementById("topbar-right");

/* ------------------------------------------------------------------ helpers */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const paras = (text) => String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("");
const isAdmin = () => !!state.user && state.user.email === ADMIN_EMAIL;
const tsDate = (t) => (t && typeof t.toDate === "function" ? t.toDate() : t instanceof Date ? t : null);
const now = () => new Date();
const isOpen = (ep) => { const p = tsDate(ep.publishAt), c = tsDate(ep.closesAt); return p && c && now() >= p && now() < c; };
const freeSeats = () => TOTAL_SEATS - state.seats.size;
const SHADOW = { I: "Gölge I", II: "Gölge II", III: "Gölge III" };
const BAD_TONES = ["kritik", "kotu"];
function publicEpisodes() { return state.episodes.filter((e) => { const p = tsDate(e.publishAt); return p && p <= now(); }); }
function currentPublic() { const p = publicEpisodes(); return p[p.length - 1]; }
function isLocked(ep) { return !!(state.profile && ep && (state.profile.lockedUntil || 0) >= ep.number); }
function lightsOff() { const c = currentPublic(); return !!(c && c.control && c.control.active && isOpen(c)); }
function baggageCount() { const c = currentPublic(); const n = c ? c.number : 0; return (state.bus.baggage || []).filter((b) => b.until >= n).length; }
async function loadMeta() {
  try { const s = await getDoc(doc(db, "meta", "bus")); state.bus = s.exists() ? { baggage: [], vanished: [], ...s.data() } : { baggage: [], vanished: [] }; } catch (e) { }
}
const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDate = (d) => d ? d.toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "-";
const inAppBrowser = () => /Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|musical_ly|Snapchat/i.test(navigator.userAgent || "");

function toast(msg, ms = 3200) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function fmtLeft(ms) {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}
function pct(counts, key) {
  if (!counts || !counts.total) return 0;
  return Math.round((counts[key] || 0) * 100 / counts.total);
}
function winnerOf(counts, keys) {
  if (!counts || !counts.total) return null;
  const max = Math.max(...keys.map((k) => counts[k] || 0));
  const top = keys.filter((k) => (counts[k] || 0) === max);
  return top.length === 1 ? top[0] : null; // null = beraberlik
}

/* ------------------------------------------------------------------ data */
async function loadProfile() {
  try {
    const s = await getDoc(doc(db, "users", state.user.uid));
    state.profile = s.exists() ? s.data() : null;
  } catch (e) {
    console.warn("profil okunamadı", e);
    state.profile = null;
  }
  state.profileLoaded = true;
}

async function loadEpisodes() {
  const list = [];
  for (let n = 1; n <= TOTAL_STOPS + 5; n++) {
    try {
      const s = await getDoc(doc(db, "episodes", String(n)));
      if (!s.exists()) break;
      list.push({ id: s.id, ...s.data() });
    } catch (e) {
      break; // henüz yayınlanmamış bölüm → izin yok → dur
    }
  }
  state.episodes = list;
  state.episodesLoaded = true;
}

async function loadMyVotes() {
  if (!state.user) return;
  const uid = state.user.uid;
  await Promise.all(state.episodes.map(async (ep) => {
    try {
      const s = await getDoc(doc(db, "votes", ep.id, "ballots", uid));
      if (s.exists()) state.myVotes[ep.id] = s.data().choice;
      if (ep.control && ep.control.active) {
        const c = await getDoc(doc(db, "controlVotes", ep.id, "ballots", uid));
        if (c.exists()) state.myCVotes[ep.id] = c.data().choice;
      }
    } catch (e) { /* yok say */ }
  }));
}

async function loadCounts(ep, kind = "votes") {
  const keys = kind === "votes" ? (ep.choiceKeys || (ep.choices || []).map((c) => c.key)) : ((ep.control && ep.control.labels) || []);
  const col = collection(db, kind, ep.id, "ballots");
  const out = { total: 0 };
  await Promise.all(keys.map(async (k) => {
    const snap = await getCountFromServer(query(col, where("choice", "==", k)));
    out[k] = snap.data().count;
  }));
  out.total = keys.reduce((a, k) => a + (out[k] || 0), 0);
  return out;
}

async function refreshCurrentCounts() {
  const ep = state.episodes[state.episodes.length - 1];
  if (!ep || !state.user) return;
  if (!state.myVotes[ep.id] && isOpen(ep)) return;
  try { state.counts[ep.id] = await loadCounts(ep); } catch (e) { console.warn(e); }
  if (ep.control && ep.control.active && (state.myCVotes[ep.id] || !isOpen(ep))) {
    try { state.cCounts[ep.id] = await loadCounts(ep, "controlVotes"); } catch (e) { }
  }
}

/* ------------------------------------------------------------------ actions */
async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      toast("Giriş yapılamadı (" + (e.code || e.message) + ")");
    }
  }
}

function validNick(n) {
  const t = (n || "").trim();
  if (t.length < 2) return "Takma ad en az 2 harf olmalı.";
  if (t.length > 18) return "Takma ad en fazla 18 karakter olabilir.";
  return null;
}

async function boardBus() {
  const nickname = state.nickDraft.trim();
  const err = validNick(nickname);
  if (err) return toast(err);
  const uid = state.user.uid;
  const full = freeSeats() <= 0;
  if (!full && !state.picked) return toast("Önce bir koltuk seç.");
  state.busy = true; render();
  try {
    var seatNo = state.picked;
    if (full) {
      await setDoc(doc(db, "users", uid), { nickname, seat: null, waiting: true, silent: state.silentDraft, joinedAt: serverTimestamp() });
    } else {
      const n = state.picked;
      await runTransaction(db, async (tx) => {
        const seatRef = doc(db, "seats", String(n));
        const s = await tx.get(seatRef);
        if (s.exists()) throw new Error("SEAT_TAKEN");
        tx.set(seatRef, { uid, nickname, at: serverTimestamp() });
        tx.set(doc(db, "users", uid), { nickname, seat: n, waiting: false, silent: state.silentDraft, joinedAt: serverTimestamp() });
      });
    }
    await loadProfile();
    await loadMyVotes();
    toast(full ? "Durakta bekliyorsun. Koltuk boşalınca binebilirsin." : `Hoş geldin ${nickname}. ${seatNo} numaralı koltuk senin.`);
  } catch (e) {
    console.warn(e);
    toast(e.message === "SEAT_TAKEN" ? "Bu koltuk az önce doldu. Başka bir koltuk seç." : "Bir sorun oldu, tekrar dene.");
    state.picked = null;
  }
  state.busy = false; render();
}

async function claimSeat() {
  if (!state.picked) return toast("Boş bir koltuk seç.");
  const uid = state.user.uid, n = state.picked, nickname = state.profile.nickname;
  state.busy = true; render();
  try {
    await runTransaction(db, async (tx) => {
      const seatRef = doc(db, "seats", String(n));
      const s = await tx.get(seatRef);
      if (s.exists()) throw new Error("SEAT_TAKEN");
      tx.set(seatRef, { uid, nickname, at: serverTimestamp() });
      tx.update(doc(db, "users", uid), { seat: n, waiting: false });
    });
    await loadProfile();
    toast(`${n} numaralı koltuğa oturdun.`);
  } catch (e) {
    toast(e.message === "SEAT_TAKEN" ? "Bu koltuk az önce doldu." : "Bir sorun oldu, tekrar dene.");
  }
  state.picked = null; state.busy = false; render();
}

async function vote(epId, key) {
  const ep = state.episodes.find((e) => e.id === epId);
  if (!ep || !isOpen(ep) || state.myVotes[epId]) return;
  if (isLocked(ep)) return toast("Bagajdasın 🔒 Bu durakta oy veremezsin.");
  const text = (ep.choices.find((c) => c.key === key) || {}).text || key;
  if (!confirm(`${key}: ${text}\n\nOyun kesinleşecek ve değiştirilemez. Emin misin?`)) return;
  state.busy = true; render();
  try {
    await setDoc(doc(db, "votes", epId, "ballots", state.user.uid), { choice: key, at: serverTimestamp() });
    state.myVotes[epId] = key;
    try { state.counts[epId] = await loadCounts(ep); } catch (e) { }
    toast("Oyun kaydedildi. Sonuç yarın sabah belli olacak.");
  } catch (e) {
    console.warn(e);
    toast("Oy kaydedilemedi. Oylama kapanmış olabilir.");
  }
  state.busy = false; render();
}

async function toggleSilent() {
  const v = !state.profile.silent;
  try {
    await updateDoc(doc(db, "users", state.user.uid), { silent: v });
    state.profile.silent = v;
    toast(v ? "Artık sessiz yolcusun: hikayede rol almayacaksın." : "Hikayede rol alabilirsin.");
  } catch (e) { toast("Kaydedilemedi."); }
  render();
}

async function controlVote(epId, label) {
  const ep = state.episodes.find((e) => e.id === epId);
  if (!ep || !isOpen(ep) || state.myCVotes[epId]) return;
  if (isLocked(ep)) return toast("Bagajdasın 🔒 Bu durakta oy veremezsin.");
  if (!confirm(`${SHADOW[label]} otobüsten insin mi?\n\nBu oy da kesinleşir ve değiştirilemez.`)) return;
  state.busy = true; render();
  try {
    await setDoc(doc(db, "controlVotes", epId, "ballots", state.user.uid), { choice: label, at: serverTimestamp() });
    state.myCVotes[epId] = label;
    try { state.cCounts[epId] = await loadCounts(ep, "controlVotes"); } catch (e) { }
    toast("Oyun kaydedildi. Gölgelerden birinin kaderi yarın belli olacak.");
  } catch (e) { toast("Oy kaydedilemedi."); }
  state.busy = false; render();
}

function viewControl(ep) {
  if (!ep.control || !ep.control.active) return "";
  const my = state.myCVotes[ep.id];
  const counts = (ep.result && ep.result.control && ep.result.control.counts) || state.cCounts[ep.id];
  const showPct = !!counts && counts.total > 0 && (!!my || !isOpen(ep));
  const chosen = ep.result && ep.result.control ? ep.result.control.chosen : null;
  const btns = ep.control.labels.map((l) => {
    const p = pct(counts, l);
    const dis = !!my || !isOpen(ep) || state.busy || isLocked(ep);
    return `<button class="choice ${my === l ? "voted" : ""} ${chosen === l ? "winner" : ""} ${showPct ? "has-pct" : ""}" data-cvote="${l}" data-ep="${esc(ep.id)}" ${dis ? "disabled" : ""}>
      ${showPct ? `<span class="bar" style="width:${p}%;background:rgba(224,72,62,.14)"></span>` : ""}
      <span class="key" style="background:#0b0c12;color:#9aa0b8">👤</span><span><b>${SHADOW[l]}</b> <span class="muted">· kim olduğu bilinmiyor</span></span>
      ${showPct ? `<span class="pct">%${p}</span>` : ""}</button>`;
  }).join("");
  return `
    <div class="card" style="background:#07080d;border-color:#3a1f22;margin-top:18px">
      <div class="eyebrow" style="color:#e0483e">🌑 Gece kontrolü</div>
      <p style="font-family:var(--serif);font-size:18px;line-height:1.7;color:#d9d2c4">Otobüsün ışıkları söndü. Rıza dikiz aynasından karanlığa bakıyor: <i>"Aranızda bu yolculuğu karanlığa sürükleyen biri var."</i> Üç gölge kıpırdamadan oturuyor. Hangisi otobüsten insin?</p>
      <p class="note">Gölgeler son karanlık yolu seçenler arasından rastgele seçildi. İsimleri kimse bilmiyor. Seçilen gölge 2 durak boyunca bagaja kilitlenir ve oy veremez.</p>
      <div class="choices">${btns}</div>
      ${my ? `<p class="note center">Oyunu <b>${SHADOW[my]}</b> için verdin.</p>` : ""}
    </div>`;
}

function personalBanners(ep) {
  const p = state.profile || {};
  let out = "";
  if (isLocked(ep)) out += `<div class="result-banner" style="background:#0b0c12;border-color:#3a1f22;color:#e8c9c5">🔒 <b>Bagaja kilitlendin.</b> Gece kontrolünde seni seçtiler. ${p.lockedUntil + 1}. durakta koltuğuna dönebileceksin. O zamana kadar okuyabilir ve sohbet edebilirsin ama oy veremezsin. Bunu sadece sen biliyorsun.</div>`;
  if (p.suspect && p.suspect.ep === ep.id && ep.control && ep.control.active && !ep.result) out += `<div class="result-banner" style="background:#0b0c12;border-color:#3a1f22;color:#e8c9c5">👤 <b>${SHADOW[p.suspect.label]} sensin.</b> Bunu sadece sen biliyorsun. Kendini ele vermek ya da saklanmak senin elinde.</div>`;
  return out;
}

/* ------------------------------------------------------------------ views */
function busMap({ selectable = false } = {}) {
  const myUid = state.user && state.user.uid;
  const dark = lightsOff() && !selectable;
  const seatBtn = (n) => {
    const s = state.seats.get(n);
    if (dark) return `<button class="seat" disabled style="background:#0b0c12;border-color:#1c2030;color:#3a4058" aria-label="Karanlık koltuk">?</button>`;
    const mine = s && s.uid === myUid;
    const cls = ["seat", s ? "taken" : "", mine ? "mine" : "", state.picked === n ? "picked" : ""].join(" ");
    const dis = !selectable || !!s;
    const label = s ? `${n} numaralı koltuk: ${s.nickname}` : `${n} numaralı koltuk: boş`;
    return `<button class="${cls}" data-seat="${n}" ${dis ? "disabled" : ""} aria-label="${esc(label)}" title="${esc(label)}">${n}${s ? `<span class="nick">${esc(s.nickname)}</span>` : ""}</button>`;
  };
  let rows = "";
  for (let r = 0; r < 9; r++) {
    const b = r * 4;
    rows += `<div class="row">${seatBtn(b + 1)}${seatBtn(b + 2)}<span class="aisle"></span>${seatBtn(b + 3)}${seatBtn(b + 4)}</div>`;
  }
  rows += `<div class="row back">${[37, 38, 39, 40, 41, 42].map(seatBtn).join("")}</div>`;
  return `
    ${dark ? `<p class="center" style="color:#e0483e;font-family:var(--mono);letter-spacing:2px">🌑 IŞIKLAR SÖNDÜ</p>` : ""}
    <div class="bus" role="group" aria-label="Otobüs koltuk planı" ${dark ? 'style="background:#05060a;border-color:#1c2030"' : ""}>
      <div class="bus-front"><span class="wheel" aria-hidden="true"></span><span>ŞOFÖR · RIZA</span><span>KAPI ▸</span></div>
      <div class="rows">${rows}</div>
    </div>
    <div class="legend">
      <span><i style="background:#1c2236;border:1px solid #39425f"></i>Boş</span>
      <span><i style="background:#2a2030;border:1px solid #4a3448"></i>Dolu</span>
      ${myUid ? `<span><i style="background:var(--amber)"></i>Senin</span>` : ""}
    </div>`;
}

function seatCounter() {
  return `<p class="center muted"><span class="counter">${state.seats.size} / ${TOTAL_SEATS}</span> koltuk dolu</p>`;
}

function viewLanding() {
  const cur = state.episodes[state.episodes.length - 1];
  const iab = inAppBrowser();
  return `
    <section class="hero">
      <div class="eyebrow">Her gün bir durak · her gün bir seçim</div>
      <h1>SON DURAK</h1>
      <span class="clock" aria-label="Saat 03:17">03:17</span>
      <div class="sign"><strong>${esc(cur ? cur.stop : "1. DURAK")}</strong><small>Son Durak'a ${cur ? Math.max(TOTAL_STOPS - cur.number + 1, 0) : TOTAL_STOPS} durak</small></div>
    </section>
    <blockquote class="intro">${esc(INTRO)}</blockquote>
    ${iab ? `<div class="card"><b>Instagram içinden giriş yapılamıyor.</b><p class="muted">Google, uygulama içi tarayıcılarda girişe izin vermiyor. Sağ üstteki <b>•••</b> menüsünden <b>"Tarayıcıda aç"</b>ı seç, sonra tekrar dene.</p></div>` : ""}
    <div class="center">
      <button class="btn google block" data-action="signin">
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Google ile otobüse bin
      </button>
      <p class="note">Koltuk almak ve oy vermek için Google ile giriş gerekiyor. Herkesin tek oyu var.</p>
      <p><a class="btn ghost" href="#kurallar">Nasıl oynanır?</a></p>
    </div>
    <h3 class="section-title">Otobüs</h3>
    ${seatCounter()}
    ${busMap()}`;
}

function viewBoarding() {
  const full = state.seatsLoaded && freeSeats() <= 0;
  return `
    <div class="card">
      <div class="eyebrow">Bilet kontrolü</div>
      <h2>Otobüse hoş geldin</h2>
      <p class="muted">Hikayede gerçek adın değil, burada seçtiğin takma ad geçecek.</p>
      <label for="nick">Takma adın</label>
      <input id="nick" maxlength="18" autocomplete="nickname" placeholder="Örn. Gece Yolcusu" value="${esc(state.nickDraft)}">
      <label class="check" style="margin-top:14px"><input type="checkbox" id="silent" ${state.silentDraft ? "checked" : ""}>
        <span>Sessiz yolcu olayım <span class="muted">(hikayede rol almam, sadece okur ve oy veririm)</span></span></label>
    </div>
    ${full ? `
      <div class="card">
        <h3>Otobüs dolu</h3>
        <p class="muted">42 koltuğun hepsi dolu. Durakta beklersen, bir koltuk boşaldığında binebilirsin. Beklerken de bölümleri okuyup oy verebilirsin.</p>
        <button class="btn block" data-action="board" ${state.busy ? "disabled" : ""}>Durakta bekle</button>
      </div>` : `
      <h3 class="section-title">Koltuğunu seç</h3>
      ${seatCounter()}
      ${busMap({ selectable: true })}
      <div class="card">
        <p class="center">${state.picked ? `Seçtiğin koltuk: <b class="counter">${state.picked}</b>` : "Haritadan boş bir koltuğa dokun."}</p>
        <button class="btn block" data-action="board" ${!state.picked || state.busy ? "disabled" : ""}>Koltuğa otur</button>
      </div>`}`;
}

function choiceButtons(ep, { interactive }) {
  const keys = ep.choiceKeys || ep.choices.map((c) => c.key);
  const my = state.myVotes[ep.id];
  const counts = (ep.result && ep.result.counts) || state.counts[ep.id];
  const showPct = !!counts && counts.total > 0 && (!!my || !isOpen(ep));
  const winner = ep.result ? ep.result.winner : null;
  return `<div class="choices">${ep.choices.map((c) => {
    const p = pct(counts, c.key);
    const cls = ["choice", my === c.key ? "voted" : "", winner === c.key ? "winner" : "", showPct ? "has-pct" : ""].join(" ");
    const dis = !interactive || !!my || !isOpen(ep) || state.busy || isLocked(ep);
    return `<button class="${cls}" data-vote="${esc(c.key)}" data-ep="${esc(ep.id)}" ${dis ? "disabled" : ""}>
      ${showPct ? `<span class="bar" style="width:${p}%"></span>` : ""}
      <span class="key">${esc(c.key)}</span><span>${esc(c.text)}</span>
      ${showPct ? `<span class="pct">%${p}</span>` : ""}
    </button>`;
  }).join("")}</div>`;
}

const TONES = {
  iyi: { icon: "🟢", label: "Doğru yol", text: "Otobüs yoluna devam ediyor… şimdilik.", bg: "rgba(76,195,138,.10)", bd: "rgba(76,195,138,.45)", fg: "#bdf0d6" },
  kritik: { icon: "🟠", label: "Kritik yol", text: "Bir şeyler ters gitmeye başladı.", bg: "rgba(242,177,52,.10)", bd: "rgba(242,177,52,.5)", fg: "#f6dfa8" },
  kotu: { icon: "🔴", label: "Karanlık yol", text: "Otobüs daha da derine giriyor.", bg: "rgba(224,72,62,.12)", bd: "rgba(224,72,62,.5)", fg: "#ffc4be" }
};
function toneBanner(result, lead) {
  const t = TONES[result.tone];
  const c = result.counts || {};
  const line = `${lead} <b>%${pct(c, result.winner)}</b> ile <b>${esc(result.winner)}</b> seçildi.`;
  if (!t) return `<div class="result-banner">${line}</div>`;
  return `<div class="result-banner" style="background:${t.bg};border-color:${t.bd};color:${t.fg}"><b style="font-size:17px">${t.icon} ${t.label}.</b> ${line} ${t.text}</div>`;
}

function resultLine(ep) {
  if (!ep.result || !ep.result.winner) return "";
  const c = ep.result.counts || {};
  const p = pct(c, ep.result.winner);
  return toneBanner(ep.result, "Yolcular karar verdi:");
}

function viewEpisode(ep) {
  const open = isOpen(ep);
  const my = state.myVotes[ep.id];
  const closes = tsDate(ep.closesAt);
  const pub = tsDate(ep.publishAt);
  const preview = pub && pub > now();
  let status = "";
  if (preview) status = `<div class="result-banner" style="background:rgba(242,177,52,.1);border-color:var(--amber-dim);color:#f3dca6">Önizleme: Bu bölümü şu an sadece sen (yönetici) görüyorsun. Yolculara <b>${fmtDate(pub)}</b> tarihinde açılacak, oylama da o zaman başlayacak.</div>`;
  else if (open && !my) status = `<div class="countdown">Oylamanın bitmesine <b data-until="${closes.getTime()}">${fmtLeft(closes - now())}</b></div>`;
  else if (open && my) status = `<p class="note center">Oyunu <b>${esc(my)}</b> olarak verdin. Oylama kapanınca kazanan seçenek belli olacak. <span class="countdown" style="display:inline-flex;margin:0">Kalan: <b data-until="${closes.getTime()}">${fmtLeft(closes - now())}</b></span></p>`;
  else if (!ep.result) status = `<p class="note center">Oylama kapandı. Yeni durak yarın sabah 08:00'de.</p>`;
  return `
    <article class="card episode">
      ${preview ? status : ""}
      <span class="stop" ${preview ? 'style="margin-top:14px"' : ""}>${esc(ep.stop || ep.number + ". DURAK")}</span>
      <h2>${esc(ep.title)}</h2>
      ${ep.number === 1 && ep.intro ? `<blockquote class="intro">${esc(ep.intro)}</blockquote>` : ""}
      ${preview ? "" : personalBanners(ep)}
      ${resultLineForPrev(ep)}
      <div class="story">${paras(ep.body)}</div>
      <h3 class="section-title">Rıza ne yapsın?</h3>
      ${choiceButtons(ep, { interactive: true })}
      ${preview ? "" : status}
      ${resultLine(ep)}
      ${viewControl(ep)}
    </article>`;
}

function resultLineForPrev(ep) {
  const prev = state.episodes.find((e) => e.number === ep.number - 1);
  if (!prev || !prev.result || !prev.result.winner) return "";
  let extra = "";
  const r = prev.result;
  if (r.vanished && r.vanished.length) extra += `<div class="result-banner" style="background:#0b0c12;border-color:#2b2f45;color:#cfd3e6">🪑 Sabah ${r.vanished.map((n) => `<b>${n}</b>`).join(" ve ")} numaralı ${r.vanished.length > 1 ? "koltuklar" : "koltuk"} boştu. Oturanı bir daha görülmedi.</div>`;
  if (r.control && r.control.chosen) extra += `<div class="result-banner" style="background:#0b0c12;border-color:#3a1f22;color:#e8c9c5">🌑 Gece kontrolü bitti. Yolcuların <b>%${pct(r.control.counts, r.control.chosen)}</b>'i <b>${SHADOW[r.control.chosen]}</b> dedi. ${SHADOW[r.control.chosen]} bagaja kilitlendi. Kim olduğunu sadece kendisi biliyor.</div>`;
  return `<div style="margin:12px 0 4px;display:grid;gap:8px">${toneBanner(r, "Önceki durakta")}${extra}</div>`;
}

function viewMain() {
  const p = state.profile;
  const eps = state.episodes;
  const cur = eps[eps.length - 1];
  const past = eps.slice(0, -1).reverse();
  let waiting = "";
  if (p.seat == null) {
    waiting = `
      <div class="card">
        <div class="eyebrow">${p.vanishedEp ? "Ortadan kayboldun" : "Durakta bekliyorsun"}</div>
        <p>${p.vanishedEp ? `${p.vanishedEp}. duraktan sonraki gece otobüsten silinip gittin. Kimse ne olduğunu bilmiyor. Şimdi karanlık bir durakta bekliyorsun. Boş bir koltuk bulursan yeniden binebilirsin. Bu arada okuyup oy verebilirsin.` : "Otobüs dolu olduğu için henüz koltuğun yok. Yine de bölümleri okuyup oy verebilirsin."}</p>
        ${freeSeats() > 0 ? `<p><b>Boş koltuk var!</b> Hemen kap:</p>${busMap({ selectable: true })}
          <button class="btn block" data-action="claim" ${!state.picked || state.busy ? "disabled" : ""}>${state.picked ? state.picked + " numaralı koltuğa geç" : "Koltuk seç"}</button>` : ""}
      </div>`;
  }
  return `
    ${waiting}
    ${cur ? viewEpisode(cur) : `
      <div class="card center">
        <span class="clock" style="font-size:44px">03:17</span>
        <h2>Otobüs henüz yola çıkmadı</h2>
        <p class="muted">İlk durak yakında açılacak. Koltuğun hazır, ${esc(p.nickname)}.</p>
      </div>`}
    ${viewChat()}
    ${past.length ? `<h3 class="section-title">Geçilen duraklar</h3>` + past.map((ep) => `
      <details class="past">
        <summary><span><b>${esc(ep.stop)}</b> · ${esc(ep.title)}</span><span class="muted">${state.myVotes[ep.id] ? "Oyun: " + esc(state.myVotes[ep.id]) : ""}</span></summary>
        <div class="inner"><div class="story">${paras(ep.body)}</div>${choiceButtons(ep, { interactive: false })}${resultLine(ep)}</div>
      </details>`).join("") : ""}
    <h3 class="section-title">Otobüs</h3>
    ${seatCounter()}
    ${busMap()}
    ${baggageCount() ? `<div class="card" style="background:#07080d;border-color:#2b2f45;text-align:center"><div class="eyebrow">🧳 Bagaj</div>
      <div style="display:flex;gap:8px;justify-content:center;margin:10px 0">${Array.from({ length: baggageCount() }, () => `<span class="seat" style="width:44px;background:#0b0c12;border-color:#3a1f22;color:#e0483e">🔒</span>`).join("")}</div>
      <p class="note" style="margin:0">${baggageCount()} yolcu bagaja kilitli. Kim oldukları bilinmiyor.</p></div>` : ""}
    <div class="card">
      <label class="check"><input type="checkbox" data-action="silent" ${p.silent ? "checked" : ""}>
        <span>Sessiz yolcuyum <span class="muted">(hikayede rol almam)</span></span></label>
    </div>
    <p class="center"><a class="btn ghost" href="#kurallar">Nasıl oynanır?</a> ${isAdmin() ? `<a class="btn ghost" href="#yonetim">Yönetim paneli →</a>` : ""}</p>`;
}


/* ------------------------------------------------------------------ chat */
// Küfür filtresi: sitede ilk kontrol. Aynı kökler firestore.rules içinde de reddediliyor.
const BAD_STEMS = ["orospu", "siktir", "sikeyim", "sikerim", "sikim", "sikik", "sikis", "sikiş", "yarrak", "yarak", "amına", "aminako",
  "pezeven", "kahpe", "şerefsiz", "serefsiz", "yavşak", "yavsak", "gavat", "ibne", "götveren", "gotveren", "götlek", "piçlik",
  "kaltak", "sürtük", "surtuk", "puşt", "pust", "dalyarak", "amcık", "amcik", "ananı", "anani", "avradını", "avradini", "gerizekal", "salak", "aptal", "embesil"];
const BAD_EXACT = ["amk", "aq", "amq", "mk", "oç", "oc", "sik", "göt", "got", "piç", "pic", "sg", "skm", "sktr", "aw", "amq"];
function normalize(t) {
  return String(t).toLocaleLowerCase("tr-TR")
    .replace(/[0]/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/4|@/g, "a").replace(/\$|5/g, "s").replace(/7/g, "t")
    .replace(/(.)\1{2,}/g, "$1$1");
}
function isRude(text) {
  const n = normalize(text);
  // harfleri araya boşluk koyarak yazmaya karşı ("o r o s p u"); sadece uzun köklerde, yanlış alarm olmasın diye
  const squashed = n.replace(/[^a-zçğıöşü]/g, "");
  if (BAD_STEMS.filter((b) => b.length >= 6).some((b) => squashed.includes(b))) return true;
  const tokens = n.split(/[^a-zçğıöşü]+/).filter(Boolean);
  return tokens.some((tk) => BAD_EXACT.includes(tk) || BAD_STEMS.some((b) => tk.startsWith(b)));
}
const CHAT_COOLDOWN = 15000;

function chatRoom() {
  const pub = state.episodes.filter((e) => { const p = tsDate(e.publishAt); return p && p <= now(); });
  const cur = pub[pub.length - 1];
  return cur ? { id: cur.id, label: `${cur.stop} sohbeti` } : { id: "peron", label: "Peron sohbeti" };
}
function ensureChat() {
  if (!state.user || !state.profile) return;
  const room = chatRoom();
  if (state.chat.room === room.id) return;
  if (state.chat.unsub) state.chat.unsub();
  state.chat = { ...state.chat, room: room.id, msgs: [], loaded: false };
  const q = query(collection(db, "chat", room.id, "messages"), orderBy("at", "desc"), limit(60));
  state.chat.unsub = onSnapshot(q, (snap) => {
    state.chat.msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
    state.chat.loaded = true;
    renderChatList();
  }, (err) => { console.warn("sohbet okunamadı", err); state.chat.loaded = true; state.chat.error = true; renderChatList(); });
}
function fmtTime(t) { const d = tsDate(t); return d ? d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : ""; }
function renderChatList() {
  const box = document.getElementById("chat-list");
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const me = state.user && state.user.uid;
  if (state.chat.error) box.innerHTML = `<p class="muted center">Sohbet şu an yüklenemedi.</p>`;
  else if (!state.chat.loaded) box.innerHTML = `<p class="muted center">Yükleniyor…</p>`;
  else if (!state.chat.msgs.length) box.innerHTML = `<p class="muted center">Henüz kimse konuşmadı. İlk sözü sen söyle.</p>`;
  else box.innerHTML = state.chat.msgs.map((m) => `
    <div class="msg ${m.uid === me ? "mine" : ""}">
      <div class="msg-head"><span class="msg-seat">${m.seat ? m.seat : "–"}</span><b>${esc(m.nickname)}</b><span class="muted">${fmtTime(m.at)}</span>
        ${isAdmin() ? `<span class="msg-tools"><button data-action="msg-del" data-id="${esc(m.id)}">Sil</button>${m.uid !== me ? `<button data-action="msg-ban" data-uid="${esc(m.uid)}" data-nick="${esc(m.nickname)}">Sohbetten at</button>` : ""}</span>` : ""}
      </div>
      <div class="msg-text">${esc(m.text)}</div>
    </div>`).join("");
  if (atBottom || state.chat.justSent) { box.scrollTop = box.scrollHeight; state.chat.justSent = false; }
}
function viewChat() {
  const room = chatRoom();
  const banned = state.profile && state.profile.banned;
  return `
    <section class="card chat">
      <div class="eyebrow">Otobüs içi sohbet</div>
      <h3 style="margin:6px 0 4px">${esc(room.label)}</h3>
      <p class="note" style="margin-top:0">Kararı birlikte konuşun, birbirinizi ikna edin. Küfür ve hakaret yasak. Kuralı çiğneyen yolcu sohbetten atılır.</p>
      <div id="chat-list" class="chat-list"></div>
      ${banned ? `<p class="error">Sohbete yazman engellendi.</p>` : `
      <div class="chat-form">
        <input id="chat-input" maxlength="280" placeholder="Bir şey yaz…" autocomplete="off" value="${esc(state.chat.draft)}">
        <button class="btn small" data-action="chat-send">Gönder</button>
      </div>
      <p class="note" id="chat-hint" style="margin:6px 0 0"></p>`}
    </section>`;
}
async function sendChat() {
  if (state.chat.sending) return;
  const text = (state.chat.draft || "").trim();
  if (!text) return;
  if (text.length > 280) return toast("Mesaj en fazla 280 karakter olabilir.");
  if (isRude(text)) return toast("Mesajında uygunsuz bir kelime var. Saygılı bir dille tekrar dene.");
  const wait = (state.chat.lastSent || 0) + CHAT_COOLDOWN - Date.now();
  if (wait > 0) return toast(`Biraz yavaş 🙂 ${Math.ceil(wait / 1000)} saniye sonra tekrar yazabilirsin.`);
  state.chat.sending = true;
  try {
    const b = writeBatch(db);
    b.set(doc(collection(db, "chat", state.chat.room, "messages")), {
      uid: state.user.uid, nickname: state.profile.nickname, seat: state.profile.seat ?? null, text, at: serverTimestamp()
    });
    b.update(doc(db, "users", state.user.uid), { lastMsgAt: serverTimestamp() });
    await b.commit();
    state.chat.draft = ""; state.chat.lastSent = Date.now(); state.chat.justSent = true;
    const inp = document.getElementById("chat-input"); if (inp) inp.value = "";
  } catch (e) {
    console.warn(e);
    toast("Mesaj gönderilemedi. Çok hızlı yazmış ya da uygunsuz bir kelime kullanmış olabilirsin.");
  }
  state.chat.sending = false;
}

function viewRules() {
  const rule = (t, d) => `<div class="admin-item" style="display:block"><b>${t}</b><p class="muted" style="margin:6px 0 0">${d}</p></div>`;
  return `
    <div class="eyebrow">Yolcu rehberi</div>
    <h2>Nasıl oynanır?</h2>
    <p class="muted">Son Durak, her gün bir bölümü yayınlanan ve yönünü yolcuların oylarıyla bulan bir gizem-korku hikayesi. Şoför Rıza'nın ne yapacağına siz karar veriyorsunuz.</p>
    <h3 class="section-title">Otobüse binmek</h3>
    <div class="admin-list">
      ${rule("Google ile giriş yap", "Oy vermek için Google hesabınla giriş yapman gerekiyor. Böylece herkesin tek oyu oluyor.")}
      ${rule("Takma adını seç", "Hikayede ve otobüste gerçek adın değil, seçtiğin takma ad görünür. Kaba ya da hakaret içeren takma adlar otobüsten indirilir.")}
      ${rule(`${TOTAL_SEATS} koltuk var`, "Boş bir koltuk seçip otur. Otobüs doluysa durakta beklersin. Bir koltuk boşalınca binebilirsin. Beklerken de bölümleri okuyup oy verebilirsin.")}
      ${rule("Sessiz yolcu", "Her bölümde bazı yolcular hikayeye dahil olabilir: tuhaf bir ses duyar, bir not bulur, ortadan kaybolur. Rol almak istemiyorsan \"Sessiz yolcu\" seçeneğini işaretle.")}
    </div>
    <h3 class="section-title">Her gün bir durak</h3>
    <div class="admin-list">
      ${rule("Yeni bölüm her sabah 08:00'de", "Cumartesi günleri iki bölüm var: 08:00 ve 20:00.")}
      ${rule("Bölüm sonunda seçim", "Her bölüm Rıza'nın önüne iki ya da üç seçenekle biter. Bölümdeki sayaç bitene kadar oy verebilirsin.")}
      ${rule("Herkesin tek oyu var", "Oyun kesinleşir, sonradan değiştirilemez. İyi düşün.")}
      ${rule("Çoğunluk kazanır", "En çok oyu alan seçenek hikayenin devamını belirler. Sonuç ertesi sabah yeni bölümle birlikte açıklanır. Beraberlikte direksiyon Rıza'da kalır ve son kararı hikayenin yaratıcısı verir.")}
      ${rule("Geçilen duraklar", "Geç katılanlar eski bölümleri okuyabilir ama verilen kararlar değişmez. Oy yalnızca güncel durakta kullanılır.")}
    </div>
    <h3 class="section-title">Yolun sonu</h3>
    <div class="admin-list">
      ${rule(`${TOTAL_STOPS} durak, tek final`, "Hikaye 1. Durak'ta başlar, Son Durak'a varınca biter.")}
      ${rule("Hiçbir seçim son değildir", "Kötü bir karar hikayeyi karanlığa sürükleyebilir ama sonraki duraklarda düzeltme şansı hep var. Son anda verilen tek bir karar bile her şeyi değiştirebilir. Gidişatın iyi mi kötü mü olduğu ise kimseye söylenmez.")}
    </div>
    <h3 class="section-title">Karanlık tarafı</h3>
    <div class="admin-list">
      ${rule("🟢 🟠 🔴 Gidişat", "Her seçim otobüsü doğru, kritik ya da karanlık bir yola sokar. Hangisinin hangisi olduğunu oylama sırasında kimse bilmez. Sonuç ertesi sabah açıklanır.")}
      ${rule("🪑 Kaybolan yolcular", "Karanlık yol seçilirse, o yolu seçenlerden biri gece ortadan kaybolabilir. Koltuğu boşalır ve durakta beklemeye başlar. Boş bir koltuk bulunca yeniden binebilir.")}
      ${rule("🌑 Gece kontrolü", "Otobüs üst üste iki kez kötü yola girerse ışıklar söner. Son karanlık yolu seçenlerden rastgele 3 gölge seçilir. İsimleri kimse bilmez, yolcular sadece Gölge I, II ve III'e oy verir.")}
      ${rule("🧳 Bagaj", "Gece kontrolünde seçilen gölge 2 durak boyunca bagaja kilitlenir. Okuyabilir ve sohbet edebilir ama oy veremez. Kim olduğunu sadece kendisi bilir. İsterse itiraf eder.")}
    </div>
    <h3 class="section-title">Otobüs içi sohbet</h3>
    <div class="admin-list">
      ${rule("Konuşun, ikna edin", "Her durağın kendi sohbeti var. Otobüs kalkmadan önce herkes Peron'da buluşur. Hangi seçeneğin neden doğru olduğunu tartışabilir, birbirinizin fikrini değiştirebilirsiniz.")}
      ${rule("Küfür ve hakaret yok", "Uygunsuz kelimeler içeren mesajlar gönderilmez. Kuralı çiğneyen, kaba davranan ya da kışkırtan yolcu sohbetten atılır.")}
      ${rule("Yavaş ve kısa", "Bir mesaj en fazla 280 karakter olabilir. 15 saniyede bir mesaj yazılabilir.")}
    </div>
    <h3 class="section-title">Gizlilik</h3>
    <p class="muted">Sadece takma adın, koltuk numaran ve oyların saklanır. E-posta adresin hiçbir yerde gösterilmez.</p>
    <p class="center" style="margin-top:24px"><a href="#" class="btn">Otobüse dön</a></p>`;
}

/* ------------------------------------------------------------------ admin */
function nextEightAm(base = now()) {
  const d = new Date(base); d.setSeconds(0, 0);
  const t = new Date(d); t.setHours(8, 0, 0, 0);
  if (t <= d) t.setDate(t.getDate() + 1);
  return t;
}
function defaultClose(pub) {
  const c = new Date(pub); c.setHours(23, 0, 0, 0);
  if (c <= pub) c.setDate(c.getDate() + 1);
  return c;
}

async function adminLoad() {
  const snap = await getDocs(collection(db, "episodes"));
  state.admin.episodes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.number - b.number);
  try {
    const w = await getDocs(query(collection(db, "users"), where("waiting", "==", true)));
    state.admin.waiting = w.docs.map((d) => ({ uid: d.id, ...d.data() }));
  } catch (e) { state.admin.waiting = []; }
}

function adminStatus(ep) {
  const p = tsDate(ep.publishAt), c = tsDate(ep.closesAt), n = now();
  if (p > n) return `<span class="pill wait">${fmtDate(p)} açılacak</span>`;
  if (n < c) return `<span class="pill live">Oylama açık</span>`;
  if (ep.result) return `<span class="pill done">Sonuç: ${esc(ep.result.winner || "-")}</span>`;
  return `<span class="pill wait">Kapandı · sonuç bekliyor</span>`;
}

function toneOpts(v) {
  return [["", "Gidişat: seçilmedi"], ["iyi", "🟢 Seçilirse: Doğru yol"], ["kritik", "🟠 Seçilirse: Kritik yol"], ["kotu", "🔴 Seçilirse: Karanlık yol"]]
    .map(([k, l]) => `<option value="${k}" ${v === k ? "selected" : ""}>${l}</option>`).join("");
}
function editorForm(ed) {
  const ch = (k) => ((ed.choices || []).find((c) => c.key === k) || {}).text || "";
  return `
    <div class="card" id="editor">
      <h3>${ed.isNew ? "Yeni bölüm" : ed.number + ". bölümü düzenle"}</h3>
      <label>Hazır taslak yükle</label>
      <select id="ed-draft"><option value="">— seç —</option>${Object.keys(DRAFTS).map((k) => `<option value="${k}">${k === "1" ? "1. bölüm: 03:17" : k[0] + ". bölüm, " + k[1] + " seçildiyse: " + esc(DRAFTS[k].title)}</option>`).join("")}</select>
      <div class="grid2">
        <div><label for="ed-number">Bölüm no</label><input id="ed-number" type="number" min="1" max="${TOTAL_STOPS + 1}" value="${esc(ed.number)}"></div>
        <div><label for="ed-stop">Durak adı</label><input id="ed-stop" value="${esc(ed.stop)}"></div>
      </div>
      <label for="ed-title">Başlık</label><input id="ed-title" value="${esc(ed.title)}">
      <label for="ed-intro">Giriş yazısı (sadece 1. bölümde gösterilir)</label><textarea id="ed-intro" style="min-height:80px">${esc(ed.intro)}</textarea>
      <label for="ed-body">Hikaye (paragrafları boş satırla ayır)</label><textarea id="ed-body" style="min-height:220px">${esc(ed.body)}</textarea>
      <p class="note">Her seçeneğin altında, seçilirse hikayenin nereye gideceğini işaretle. Yolcular bunu oylama bitip sonuç açıklanınca görür. O zamana kadar sadece sen görürsün.</p>
      <label for="ed-A">A seçeneği</label><input id="ed-A" value="${esc(ch("A"))}"><select id="ed-tA" style="margin-top:6px">${toneOpts(ed.tones && ed.tones.A)}</select>
      <label for="ed-B">B seçeneği</label><input id="ed-B" value="${esc(ch("B"))}"><select id="ed-tB" style="margin-top:6px">${toneOpts(ed.tones && ed.tones.B)}</select>
      <label for="ed-C">C seçeneği (isteğe bağlı)</label><input id="ed-C" value="${esc(ch("C"))}"><select id="ed-tC" style="margin-top:6px">${toneOpts(ed.tones && ed.tones.C)}</select>
      <label class="check" style="margin-top:16px"><input type="checkbox" id="ed-control" ${ed.control ? "checked" : ""} ${ed.controlLocked ? "disabled" : ""}>
        <span>🌑 Bu durakta <b>Gece kontrolü</b> olsun <span class="muted">${ed.controlLocked ? "(kuruldu, değiştirilemez)" : ed.controlSuggested ? "(önceki iki durak kötü yola girdi, öneriliyor)" : "(önceki durakta kötü yolu seçenlerden 3 gölge seçilir)"}</span></span></label>
      <div class="grid2">
        <div><label for="ed-pub">Yayın zamanı</label><input id="ed-pub" type="datetime-local" value="${toLocalInput(ed.pub)}"></div>
        <div><label for="ed-close">Oylama bitişi</label><input id="ed-close" type="datetime-local" value="${toLocalInput(ed.close)}"></div>
      </div>
      <p class="note">Bölüm, yayın zamanı gelene kadar yolculara görünmez. Örneğin yarın 08:00'i seçersen sabah kendiliğinden açılır.</p>
      <div class="btn-row">
        <button class="btn" data-action="ed-save" ${state.busy ? "disabled" : ""}>Kaydet</button>
        <button class="btn ghost" data-action="ed-cancel">Vazgeç</button>
        ${ed.isNew ? "" : `<button class="btn ghost" data-action="ed-delete" style="margin-left:auto;color:#ff8f86">Sil</button>`}
      </div>
    </div>`;
}

function viewAdmin() {
  const a = state.admin;
  if (!a.episodes) {
    adminLoad().then(render).catch((e) => { console.warn(e); toast("Yönetim verisi okunamadı. Güvenlik kurallarını yükledin mi?"); });
    return `<div class="loading"><span class="clock">03:17</span></div>`;
  }
  const tabs = `<div class="tabs"><button data-tab="bolumler" class="${a.tab === "bolumler" ? "on" : ""}">Bölümler</button><button data-tab="yolcular" class="${a.tab === "yolcular" ? "on" : ""}">Yolcular (${state.seats.size}/${TOTAL_SEATS})</button></div>`;
  let body = "";
  if (a.tab === "bolumler") {
    if (a.editing) body = editorForm(a.editing);
    else if (a.resultFor) {
      const ep = a.episodes.find((e) => e.id === a.resultFor);
      const keys = ep.choiceKeys;
      const c = a.resultCounts;
      const auto = c ? winnerOf(c, keys) : null;
      body = `
        <div class="card">
          <h3>${esc(ep.stop)} · oy sonuçları</h3>
          ${!c ? `<p class="muted">Sayılıyor…</p>` : `
            <p class="muted">Toplam oy: <b class="counter">${c.total}</b> ${isOpen(ep) ? "· oylama hâlâ açık" : ""}</p>
            <div class="choices">${ep.choices.map((ch) => `<div class="choice has-pct ${auto === ch.key ? "winner" : ""}"><span class="bar" style="width:${pct(c, ch.key)}%"></span><span class="key">${esc(ch.key)}</span><span>${esc(ch.text)} <span class="muted">(${c[ch.key] || 0} oy)</span>${TONES[(a.resultTones || {})[ch.key]] ? `<br><small>${TONES[a.resultTones[ch.key]].icon} ${TONES[a.resultTones[ch.key]].label}</small>` : ""}</span><span class="pct">%${pct(c, ch.key)}</span></div>`).join("")}</div>
            ${auto ? `<p class="note">Kazanan: <b>${esc(auto)}</b></p>` : `<p class="note">${c.total ? "Beraberlik var. Kazananı sen seç:" : "Henüz oy yok. İstersen kazananı elle seçebilirsin:"}</p>`}
            <div class="btn-row">${keys.map((k) => `<button class="btn ${k === auto ? "" : "ghost"} small" data-action="save-result" data-key="${k}">${k} kazandı olarak kaydet</button>`).join("")}</div>
            ${ep.control && ep.control.active ? `<p class="note">🌑 Bu durakta gece kontrolü var. Sonucu kaydettiğinde en çok oyu alan gölge otomatik olarak 2 durak bagaja kilitlenir. Kim olduğu sana da gösterilmez.</p>` : ""}
            ${(state.admin.resultTones || {})[auto] === "kotu" ? `<p class="note">🔴 Kazanan karanlık yol. Kaydederken bu yolu seçenlerden birinin kaybolmasını isteyip istemediğin sorulacak.</p>` : ""}
            ${isOpen(ep) ? `<div class="btn-row"><button class="btn danger small" data-action="close-now">Oylamayı şimdi kapat</button></div>` : ""}
          `}
          <div class="btn-row"><button class="btn ghost small" data-action="result-back">← Geri</button></div>
        </div>`;
    } else {
      body = `
        <div class="btn-row"><button class="btn" data-action="ed-new">+ Yeni bölüm</button></div>
        <div class="admin-list" style="margin-top:12px">${a.episodes.length ? a.episodes.map((ep) => `
          <div class="admin-item">
            <div><b>${esc(ep.stop)}</b> · ${esc(ep.title)}<br>${adminStatus(ep)}</div>
            <div class="btn-row" style="margin:0">
              <button class="btn ghost small" data-action="ed-edit" data-id="${esc(ep.id)}">Düzenle</button>
              <button class="btn ghost small" data-action="result" data-id="${esc(ep.id)}">Oylar</button>
            </div>
          </div>`).join("") : `<p class="muted">Henüz bölüm yok. "Yeni bölüm"e bas, "Hazır taslak yükle"den 1. bölümü seç ve kaydet.</p>`}
        </div>`;
    }
  } else {
    const list = [...state.seats.entries()].sort((x, y) => x[0] - y[0]);
    body = `
      <div class="admin-list" style="margin-top:12px">${list.length ? list.map(([n, s]) => `
        <div class="admin-item"><div><span class="counter">${n}</span> · ${esc(s.nickname)}</div>
        <button class="btn ghost small" data-action="free-seat" data-seat="${n}" data-uid="${esc(s.uid)}">Koltuğu boşalt</button></div>`).join("") : `<p class="muted">Henüz kimse binmedi.</p>`}
      </div>
      <h3 class="section-title">Durakta bekleyenler (${(a.waiting || []).length})</h3>
      <div class="admin-list">${(a.waiting || []).map((w) => `<div class="admin-item"><div>${esc(w.nickname)}</div><span class="pill">bekliyor</span></div>`).join("") || `<p class="muted">Bekleyen yok.</p>`}</div>
      <p class="note">"Koltuğu boşalt", hikayede kaybolan bir yolcunun koltuğunu açar. O kişi durakta bekleyenlere geçer.</p>`;
  }
  return `
    <div class="eyebrow">Yönetim</div>
    <h2>Kontrol paneli</h2>
    ${tabs}
    ${body}
    <p class="center" style="margin-top:24px"><a href="#" class="btn ghost small">← Siteye dön</a></p>`;
}

function readEditor() {
  const v = (id) => (document.getElementById(id) || {}).value || "";
  const choices = ["A", "B", "C"].map((k) => ({ key: k, text: v("ed-" + k).trim() })).filter((c) => c.text);
  return {
    number: parseInt(v("ed-number"), 10),
    stop: v("ed-stop").trim(),
    title: v("ed-title").trim(),
    intro: v("ed-intro").trim(),
    body: v("ed-body").trim(),
    choices,
    pub: new Date(v("ed-pub")),
    close: new Date(v("ed-close"))
  };
}

/* gece kontrolü / kaybolma yardımcıları (yalnızca yönetici) */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function badVoters(ep, winner) {
  const snap = await getDocs(query(collection(db, "votes", ep.id, "ballots"), where("choice", "==", winner)));
  const out = [];
  for (const d of snap.docs) {
    try { const u = await getDoc(doc(db, "users", d.id)); if (u.exists()) out.push({ uid: d.id, ...u.data() }); } catch (e) { }
  }
  return out;
}
function needsControl(nextNumber) {
  const eps = state.admin.episodes || [];
  const a = eps.find((e) => e.number === nextNumber - 1), b = eps.find((e) => e.number === nextNumber - 2);
  if (!a || !b || !a.result || !b.result) return false;
  if (a.control && a.control.active) return false; // üst üste kontrol olmasın
  return BAD_TONES.includes(a.result.tone) && BAD_TONES.includes(b.result.tone);
}
async function setupControl(newEp) {
  const prev = (state.admin.episodes || []).find((e) => e.number === newEp.number - 1);
  if (!prev || !prev.result || !prev.result.winner) return null;
  const pool = shuffle((await badVoters(prev, prev.result.winner)).filter((u) => !u.silent && !((u.lockedUntil || 0) >= newEp.number)));
  if (pool.length < 2) return null;
  const labels = ["I", "II", "III"].slice(0, Math.min(3, pool.length));
  const suspects = {};
  const b = writeBatch(db);
  labels.forEach((l, i) => { suspects[l] = pool[i].uid; b.update(doc(db, "users", pool[i].uid), { suspect: { ep: newEp.id, label: l } }); });
  b.set(doc(db, "controlSecrets", newEp.id), { suspects });
  await b.commit();
  return { active: true, labels };
}

async function adminSave() {
  const e = readEditor();
  if (!e.number || e.number < 1) return toast("Bölüm numarası gir.");
  if (!e.title || !e.body) return toast("Başlık ve hikaye boş olamaz.");
  if (!e.choices.find((c) => c.key === "A") || !e.choices.find((c) => c.key === "B")) return toast("En az A ve B seçeneği gerekli.");
  if (isNaN(e.pub) || isNaN(e.close) || e.close <= e.pub) return toast("Oylama bitişi, yayın zamanından sonra olmalı.");
  const prevId = state.admin.editing.isNew ? null : state.admin.editing.id;
  const id = String(e.number);
  if (state.admin.editing.isNew && state.admin.episodes.find((x) => x.id === id) && !confirm(`${id}. bölüm zaten var. Üzerine yazılsın mı?`)) return;
  state.busy = true; render();
  try {
    await setDoc(doc(db, "episodes", id), {
      number: e.number, stop: e.stop || `${e.number}. DURAK`, title: e.title, intro: e.intro, body: e.body,
      choices: e.choices, choiceKeys: e.choices.map((c) => c.key),
      publishAt: Timestamp.fromDate(e.pub), closesAt: Timestamp.fromDate(e.close), updatedAt: serverTimestamp()
    }, { merge: true });
    await setDoc(doc(db, "episodeSecrets", id), { tones: state.admin.editing.tones || {} });
    if (state.admin.editing.control && !state.admin.editing.controlLocked) {
      const ctl = await setupControl({ id, number: e.number });
      if (ctl) { await updateDoc(doc(db, "episodes", id), { control: ctl }); toast(`🌑 Gece kontrolü kuruldu: ${ctl.labels.length} gölge seçildi.`); }
      else toast("Gece kontrolü kurulamadı: önceki durakta kötü yolu seçen en az 2 (sessiz olmayan) yolcu yok.");
    }
    if (prevId && prevId !== id) await deleteDoc(doc(db, "episodes", prevId));
    state.admin.editing = null;
    await adminLoad(); await loadEpisodes(); await loadMyVotes();
    toast("Bölüm kaydedildi.");
  } catch (err) { console.warn(err); toast("Kaydedilemedi: " + (err.code || err.message)); }
  state.busy = false; render();
}

async function adminShowResult(id) {
  state.admin.resultFor = id; state.admin.resultCounts = null; state.admin.resultTones = {}; render();
  try { const sec = await getDoc(doc(db, "episodeSecrets", id)); if (sec.exists()) state.admin.resultTones = sec.data().tones || {}; } catch (e) { }
  const ep = state.admin.episodes.find((e) => e.id === id);
  try { state.admin.resultCounts = await loadCounts(ep); } catch (e) { toast("Oylar sayılamadı."); state.admin.resultCounts = { total: 0 }; }
  render();
}

/* ------------------------------------------------------------------ render */
function renderTopbar() {
  if (!state.user) { $right.innerHTML = ""; return; }
  const seat = state.profile && state.profile.seat;
  $right.innerHTML = `${state.profile ? `<span class="seat-badge" title="${esc(state.profile.nickname)}">${seat ? "Koltuk " + seat : "Durakta"}</span>` : ""}
    <button class="btn ghost small" data-action="signout">Çıkış</button>`;
}

function render() {
  renderTopbar();
  let html;
  if (location.hash === "#yonetim" && isAdmin()) html = viewAdmin();
  else if (location.hash === "#kurallar") html = viewRules();
  else if (!state.user) html = viewLanding();
  else if (!state.profileLoaded || !state.episodesLoaded) html = `<div class="loading"><span class="clock">03:17</span></div>`;
  else if (!state.profile) html = viewBoarding();
  else html = viewMain();
  const focused = document.activeElement && document.activeElement.id;
  $app.innerHTML = html;
  if (focused === "nick") { const n = document.getElementById("nick"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  if (document.getElementById("chat-list")) { ensureChat(); renderChatList(); }
  if (focused === "chat-input") { const n = document.getElementById("chat-input"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }
}

/* ------------------------------------------------------------------ events */
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-action],[data-seat],[data-vote],[data-cvote],[data-tab]");
  if (!t || t.disabled) return;
  if (t.dataset.tab) { state.admin.tab = t.dataset.tab; state.admin.editing = null; state.admin.resultFor = null; return render(); }
  if (t.dataset.vote) return vote(t.dataset.ep, t.dataset.vote);
  if (t.dataset.cvote) return controlVote(t.dataset.ep, t.dataset.cvote);
  const action = t.dataset.action;
  if (!action && t.dataset.seat) { state.picked = Number(t.dataset.seat); return render(); }
  switch (action) {
    case "signin": return signIn();
    case "signout": await signOut(auth); location.hash = ""; return;
    case "board": return boardBus();
    case "claim": return claimSeat();
    case "silent": return toggleSilent();
    case "chat-send": return sendChat();
    case "msg-del": {
      if (!confirm("Bu mesaj silinsin mi?")) return;
      try { await deleteDoc(doc(db, "chat", state.chat.room, "messages", t.dataset.id)); } catch (e) { toast("Silinemedi."); }
      return;
    }
    case "msg-ban": {
      if (!confirm(`${t.dataset.nick} sohbetten atılsın mı? Oy vermeye ve okumaya devam edebilir ama yazamaz.`)) return;
      try { await updateDoc(doc(db, "users", t.dataset.uid), { banned: true }); toast(`${t.dataset.nick} artık sohbete yazamaz.`); } catch (e) { toast("Yapılamadı."); }
      return;
    }
    case "ed-new": {
      const last = state.admin.episodes[state.admin.episodes.length - 1];
      const num = last ? last.number + 1 : 1;
      const pub = num === 1 ? new Date(Math.ceil(Date.now() / 300000) * 300000) : nextEightAm();
      const sug = needsControl(num);
      state.admin.editing = { isNew: true, number: num, stop: `${num}. DURAK`, title: "", intro: "", body: "", choices: [], pub, close: defaultClose(pub), control: sug, controlSuggested: sug };
      return render();
    }
    case "ed-edit": {
      const ep = state.admin.episodes.find((e) => e.id === t.dataset.id);
      state.admin.editing = { ...ep, isNew: false, pub: tsDate(ep.publishAt), close: tsDate(ep.closesAt), tones: {}, control: !!(ep.control && ep.control.active), controlLocked: !!(ep.control && ep.control.active) };
      try { const sec = await getDoc(doc(db, "episodeSecrets", ep.id)); if (sec.exists()) state.admin.editing.tones = sec.data().tones || {}; } catch (e) { }
      return render();
    }
    case "ed-cancel": state.admin.editing = null; return render();
    case "ed-save": return adminSave();
    case "ed-delete": {
      const id = state.admin.editing.id;
      if (!confirm(`${id}. bölüm silinsin mi? Bu geri alınamaz.`)) return;
      try { await deleteDoc(doc(db, "episodes", id)); state.admin.editing = null; await adminLoad(); await loadEpisodes(); toast("Silindi."); }
      catch (e) { toast("Silinemedi."); }
      return render();
    }
    case "result": return adminShowResult(t.dataset.id);
    case "result-back": state.admin.resultFor = null; return render();
    case "save-result": {
      const ep = state.admin.episodes.find((e) => e.id === state.admin.resultFor);
      const c = state.admin.resultCounts || { total: 0 };
      try {
        const tone = (state.admin.resultTones || {})[t.dataset.key] || null;
        const result = { winner: t.dataset.key, counts: c, tone, savedAt: serverTimestamp() };
        const meta = { baggage: [...(state.bus.baggage || [])], vanished: [...(state.bus.vanished || [])] };
        // 1) gece kontrolü sonucu: seçilen gölge bagaja
        if (ep.control && ep.control.active) {
          const cc = await loadCounts(ep, "controlVotes");
          const max = Math.max(0, ...ep.control.labels.map((l) => cc[l] || 0));
          const top = ep.control.labels.filter((l) => (cc[l] || 0) === max);
          const chosen = shuffle([...top])[0];
          const sec = await getDoc(doc(db, "controlSecrets", ep.id));
          const uid = sec.exists() ? sec.data().suspects[chosen] : null;
          if (uid) { await updateDoc(doc(db, "users", uid), { lockedUntil: ep.number + 2 }); meta.baggage.push({ until: ep.number + 2, ep: ep.id }); }
          result.control = { chosen, counts: cc };
        }
        // 2) karanlık yol: kötü yolu seçenlerden biri ortadan kaybolur
        if (tone === "kotu" && confirm("🔴 Karanlık yol seçildi. Bu yolu seçenlerden biri ortadan kaybolsun mu? (Koltuğu boşalır, durakta beklemeye başlar.)")) {
          const pool = shuffle((await badVoters(ep, t.dataset.key)).filter((u) => !u.silent && u.seat));
          const n = pool.length >= 15 ? 2 : pool.length ? 1 : 0;
          const gone = pool.slice(0, n);
          if (gone.length) {
            const b = writeBatch(db);
            gone.forEach((u) => { b.delete(doc(db, "seats", String(u.seat))); b.update(doc(db, "users", u.uid), { seat: null, waiting: true, vanishedEp: ep.number }); });
            await b.commit();
            result.vanished = gone.map((u) => u.seat);
            meta.vanished.push(...gone.map((u) => ({ seat: u.seat, ep: ep.id })));
          }
        }
        await updateDoc(doc(db, "episodes", ep.id), { result });
        await setDoc(doc(db, "meta", "bus"), meta);
        state.bus = meta;
        toast(`${ep.stop}: ${t.dataset.key} kazanan olarak kaydedildi.${result.control ? " 🌑 " + SHADOW[result.control.chosen] + " bagaja kilitlendi." : ""}${result.vanished ? " 🪑 " + result.vanished.join(", ") + " numaralı koltuk boşaldı." : ""}`, 6000);
        state.admin.resultFor = null; await adminLoad(); await loadEpisodes();
      } catch (e) { toast("Kaydedilemedi."); }
      return render();
    }
    case "close-now": {
      const ep = state.admin.episodes.find((e) => e.id === state.admin.resultFor);
      if (!confirm("Oylama şimdi kapatılsın mı?")) return;
      try { await updateDoc(doc(db, "episodes", ep.id), { closesAt: Timestamp.now() }); await adminLoad(); await loadEpisodes(); await adminShowResult(ep.id); }
      catch (e) { toast("Kapatılamadı."); }
      return;
    }
    case "free-seat": {
      const n = t.dataset.seat, uid = t.dataset.uid;
      if (!confirm(`${n} numaralı koltuk boşaltılsın mı? Yolcu durakta bekleyenlere geçer.`)) return;
      try {
        const b = writeBatch(db);
        b.delete(doc(db, "seats", n));
        b.update(doc(db, "users", uid), { seat: null, waiting: true });
        await b.commit(); await adminLoad(); toast("Koltuk boşaltıldı.");
      } catch (e) { toast("Boşaltılamadı."); }
      return render();
    }
  }
});

document.addEventListener("input", (ev) => {
  const id = ev.target.id || "";
  if (id === "nick") state.nickDraft = ev.target.value;
  if (id === "chat-input") state.chat.draft = ev.target.value;
  const ed = state.admin.editing;
  if (ed && id.startsWith("ed-") && id !== "ed-draft") {
    const val = ev.target.value;
    if (["ed-tA", "ed-tB", "ed-tC"].includes(id)) { ed.tones = { ...(ed.tones || {}), [id.slice(4)]: val }; return; }
    if (id === "ed-number") ed.number = parseInt(val, 10) || "";
    else if (id === "ed-pub") ed.pub = new Date(val);
    else if (id === "ed-close") ed.close = new Date(val);
    else if (["ed-A", "ed-B", "ed-C"].includes(id)) {
      const k = id.slice(3);
      const rest = (ed.choices || []).filter((c) => c.key !== k);
      ed.choices = [...rest, { key: k, text: val }].sort((a, b) => a.key.localeCompare(b.key));
    } else ed[id.slice(3)] = val;
  }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "silent") state.silentDraft = ev.target.checked;
  if (ev.target.id === "ed-control" && state.admin.editing) state.admin.editing.control = ev.target.checked;
  if (["ed-tA", "ed-tB", "ed-tC"].includes(ev.target.id) && state.admin.editing) {
    state.admin.editing.tones = { ...(state.admin.editing.tones || {}), [ev.target.id.slice(4)]: ev.target.value };
  }
  if (ev.target.id === "ed-draft" && ev.target.value) {
    const d = DRAFTS[ev.target.value];
    const ed = state.admin.editing;
    Object.assign(ed, { number: d.number, stop: d.stop, title: d.title, intro: d.intro, body: d.body, choices: d.choices });
    if (ed.isNew && d.number !== 1) { ed.pub = nextEightAm(); ed.close = defaultClose(ed.pub); }
    render();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.target.id === "chat-input" && ev.key === "Enter") { ev.preventDefault(); sendChat(); }
});
window.addEventListener("hashchange", () => { state.admin.editing = null; state.admin.resultFor = null; render(); window.scrollTo(0, 0); });

// geri sayım
setInterval(() => {
  document.querySelectorAll("[data-until]").forEach((el) => {
    const left = Number(el.dataset.until) - Date.now();
    el.textContent = fmtLeft(left);
    if (left <= 0 && !render._closing) { render._closing = true; setTimeout(() => { render._closing = false; render(); }, 1200); }
  });
}, 1000);

/* ------------------------------------------------------------------ boot */
onSnapshot(collection(db, "seats"), (snap) => {
  state.seats = new Map(snap.docs.map((d) => [Number(d.id), d.data()]));
  state.seatsLoaded = true;
  if (state.picked && state.seats.has(state.picked)) state.picked = null;
  render();
}, (err) => { console.warn("koltuklar okunamadı", err); state.seatsLoaded = true; render(); });

getRedirectResult(auth).catch(() => {});

const episodesReady = Promise.all([loadEpisodes(), loadMeta()]);
onAuthStateChanged(auth, async (u) => {
  state.user = u; state.profile = null; state.profileLoaded = false; state.myVotes = {}; state.counts = {}; state.myCVotes = {}; state.cCounts = {};
  state.admin = { tab: "bolumler", episodes: null, editing: null, waiting: null, resultFor: null, resultCounts: null };
  if (state.chat.unsub) state.chat.unsub();
  state.chat = { room: null, msgs: [], loaded: false, draft: "", unsub: null, lastSent: 0, sending: false };
  render();
  if (u) {
    await Promise.all([loadProfile(), episodesReady]);
    await loadMyVotes();
    await refreshCurrentCounts();
  }
  render();
});
episodesReady.then(render);
