// Cloudflare Worker (Static Assets + D1)
// مسیرهای /api/* اینجا پردازش می‌شوند و بقیه‌ی درخواست‌ها فایل‌های public/ را برمی‌گردانند.
// نیازمند D1 binding با نام DB

const GAMES = new Set(['drift0','drift1','drift2','drift3','drift4','stack','flip','peng','draw']);
const MAX_SCORE = { drift: 5e7, stack: 500, flip: 1e6, peng: 20000 }; // سقف منطقی برای جلوگیری از امتیاز جعلی

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// کلید یکتایی نام: حروف عربی→فارسی، حذف فاصله/نیم‌فاصله/ارقام فارسی→لاتین، کوچک‌کردن
function nameKey(n) {
  return n
    .normalize('NFKC')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u064B-\u065F\u0640]/g, '')           // اعراب و کشیده
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[\s\u200c\u200d\u200e\u200f_\-.]/g, '')
    .toLowerCase();
}
function cleanName(n) {
  return String(n || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
}
const NAME_RE = /^[\p{L}\p{N} \u200c_.\-]{2,16}$/u;

function token() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function body(req) { try { return await req.json(); } catch { return {}; } }

async function handleApi(request, env, route) {
  const db = env.DB;
  if (!db) return json({ error: 'no_db' }, 500);
  const url = new URL(request.url);

  try {
    /* ---- ثبت نام ---- */
    if (route === 'register' && request.method === 'POST') {
      const b = await body(request);
      const name = cleanName(b.name);
      if (!NAME_RE.test(name)) return json({ error: 'invalid', msg: 'نام باید ۲ تا ۱۶ حرف باشد.' }, 400);
      const key = nameKey(name);
      if (key.length < 2) return json({ error: 'invalid', msg: 'نام معتبر نیست.' }, 400);
      const exists = await db.prepare('SELECT 1 FROM players WHERE name_key=?').bind(key).first();
      if (exists) return json({ error: 'taken', msg: 'این نام قبلاً گرفته شده، نام دیگری انتخاب کن.' }, 409);
      const t = token();
      try {
        await db.prepare('INSERT INTO players(name,name_key,token,created_at) VALUES(?,?,?,?)')
          .bind(name, key, t, Date.now()).run();
      } catch (e) {
        return json({ error: 'taken', msg: 'این نام قبلاً گرفته شده، نام دیگری انتخاب کن.' }, 409);
      }
      return json({ ok: true, name, token: t });
    }

    /* ---- بازی نقاشی: اتصال WebSocket به اتاق (Durable Object) ---- */
    if (route === 'draw/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'ws_only' }, 426);
      const room = (url.searchParams.get('room') || '').toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room) || !env.DRAW) return json({ error: 'bad' }, 400);
      return env.DRAW.get(env.DRAW.idFromName(room)).fetch(request);
    }

    /* ---- بررسی اعتبار نام ذخیره‌شده ---- */
    if (route === 'me' && request.method === 'POST') {
      const b = await body(request);
      const p = await db.prepare('SELECT name FROM players WHERE token=?').bind(String(b.token || '')).first();
      return p ? json({ ok: true, name: p.name }) : json({ error: 'unknown' }, 401);
    }

    /* ---- ثبت امتیاز ---- */
    if (route === 'score' && request.method === 'POST') {
      const b = await body(request);
      const game = String(b.game || '');
      const score = Math.floor(Number(b.score));
      if (game === 'draw' || !GAMES.has(game) || !Number.isFinite(score) || score <= 0) return json({ error: 'bad' }, 400); // امتیاز نقاشی فقط از سمت سرورِ اتاق ثبت می‌شود
      const cap = MAX_SCORE[game.replace(/\d+$/, '')];
      if (score > cap) return json({ error: 'bad' }, 400);
      const p = await db.prepare('SELECT id FROM players WHERE token=?').bind(String(b.token || '')).first();
      if (!p) return json({ error: 'unknown' }, 401);
      await db.prepare(
        `INSERT INTO scores(game,player_id,score,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(game,player_id) DO UPDATE SET
           score = MAX(score, excluded.score),
           updated_at = CASE WHEN excluded.score > score THEN excluded.updated_at ELSE updated_at END`
      ).bind(game, p.id, score, Date.now()).run();
      return json({ ok: true });
    }

    /* ---- جدول برترین‌ها ---- */
    if (route === 'leaderboard' && request.method === 'GET') {
      const game = url.searchParams.get('game') || '';
      if (!GAMES.has(game)) return json({ error: 'bad' }, 400);
      const { results } = await db.prepare(
        `SELECT p.name AS name, s.score AS score FROM scores s
         JOIN players p ON p.id = s.player_id
         WHERE s.game = ? ORDER BY s.score DESC, s.updated_at ASC LIMIT 5`
      ).bind(game).all();
      return json({ game, top: results || [] });
    }

    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname.slice(5).replace(/\/+$/, ''));
    }
    return env.ASSETS.fetch(request);
  },
};

/* ======================================================================
   بازی «نقاشی حدسی» — هر اتاق یک Durable Object است.
   همه‌چیز (بازیکن‌ها، نقاشی، چت، زمان‌ها) فقط در حافظه‌ی همین اتاق می‌ماند و ذخیره نمی‌شود.
   تنها چیزی که در D1 نوشته می‌شود: امتیاز پایان بازی (جمع امتیازها) برای جدول ۵ نفر برتر.
   ====================================================================== */
const WRITE_MS = 30000;   // مهلت نوشتن جمله
const REVEAL_MS = 7000;   // نمایش جمله‌ی درست بین نوبت‌ها
const MAX_PLAYERS = 16;

const SENTENCES = [
  'گربه روی پشت‌بام خوابیده', 'پسر کوچولو بادکنک قرمز دارد', 'ماهی توی آب شنا می‌کند',
  'خورشید پشت کوه غروب می‌کند', 'مرد پیر زیر درخت چای می‌نوشد', 'دختر با دوچرخه به مدرسه می‌رود',
  'سگ دنبال توپ می‌دود', 'باران روی چتر می‌بارد', 'پرنده روی شاخه آواز می‌خواند',
  'کشتی در دریای طوفانی گیر کرده', 'فضانورد روی ماه پرچم می‌زند', 'خانواده‌ای در پارک پیک‌نیک می‌کنند',
  'ماشین قرمز توی جاده می‌رود', 'بچه‌ها آدم‌برفی درست می‌کنند', 'ماه و ستاره بالای خانه',
  'فیل بزرگ آب می‌خورد', 'مرغ و خروس توی حیاط', 'معلم پای تخته می‌نویسد',
  'اژدهای آتشین قلعه را می‌سوزاند', 'خرس عسل می‌خورد', 'قایق کوچک روی دریاچه',
  'مرد با کلاه بزرگ ماهی می‌گیرد', 'ربات غذا درست می‌کند', 'بچه‌ای پشت پنجره برف تماشا می‌کند',
  'شتر توی بیابان راه می‌رود', 'زن جوان گل می‌کارد', 'هواپیما بالای ابرها پرواز می‌کند',
  'دزد با چراغ‌قوه وارد خانه می‌شود', 'پنگوئن روی یخ سُر می‌خورد', 'کوه‌نورد به قله رسید',
];

// نرمال‌سازی فارسی/عربی برای مقایسه‌ی حدس‌ها
function normG(s) {
  return String(s || '').normalize('NFKC')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ۀة]/g, 'ه')
    .replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ/g, 'ی')
    .replace(/[\u064B-\u065F\u0640]/g, '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[\u200c\u200d]/g, '')
    .toLowerCase();
}
const wordsOf = s => normG(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function lev(a, b) {
  a = [...a]; b = [...b];
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let p = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[n];
}
// ok: حدس درست (غلط تایپی کوچک یا جابه‌جایی کلمات مجاز)  close: نزدیک است
function matchGuess(guess, target) {
  const gw = wordsOf(guess), tw = wordsOf(target);
  const g = gw.join(''), t = tw.join('');
  if (!g || !t) return { ok: false, close: false, ratio: 0, common: 0 };
  if (g === t) return { ok: true, close: false, ratio: 1, common: 1 };
  const ratio = 1 - lev(g, t) / Math.max(g.length, t.length);
  const gs = new Set(gw);
  const common = tw.filter(w => gs.has(w)).length / tw.length;
  const ok = (t.length >= 8 && ratio >= 0.86) || (common === 1 && gw.length <= tw.length + 2);
  return { ok, close: !ok && (ratio >= 0.6 || common >= 0.5), ratio, common };
}
function makeHint(sentence, stage) {
  const keep = stage === 0 ? 0 : stage === 1 ? 1 : 2;
  return sentence.trim().split(/\s+/).map(w =>
    [...w].map((c, i) => (i < keep || !/[\p{L}\p{N}]/u.test(c)) ? c : '_').join(''));
}
const rnd = n => Math.floor(Math.random() * n);
function pick(arr, k) {
  const a = [...arr], out = [];
  while (out.length < k && a.length) out.push(a.splice(rnd(a.length), 1)[0]);
  return out;
}
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export class DrawRoom {
  constructor(state, env) {
    this.env = env;
    this.iv = null;
    this.reset();
  }

  reset() {
    clearInterval(this.iv); this.iv = null;
    this.players = new Map();      // id -> {id,name,score,guessed,ws,connected,msgAt}
    this.hostId = 0;
    this.created = false;
    this.settings = { rounds: 2, time: 90 };
    this.resetGame();
  }
  resetGame() {
    this.phase = 'lobby';          // lobby | write | draw | reveal
    this.round = 0; this.turn = 0;
    this.queue = [];
    this.drawerId = 0; this.sentence = ''; this.sugg = [];
    this.strokes = []; this.pts = 0;
    this.deadline = 0; this.total = 1;
    this.hintStage = 0; this.guessN = 0;
    this.gains = new Map();
  }

  /* ---------- اتصال ---------- */
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', ev => {
      if (typeof ev.data !== 'string' || ev.data.length > 6000) return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      this.onMsg(server, m).catch(e => console.error('draw msg', e && e.stack || e));
    });
    const gone = () => this.onClose(server);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }
  broadcast(o, filter) {
    for (const p of this.players.values()) if (p.ws && (!filter || filter(p))) this.send(p.ws, o);
  }
  sys(text, kind = 'sys') { this.broadcast({ t: 'chat', kind, text }); }
  connected() { return [...this.players.values()].filter(p => p.connected); }

  view(p) {
    const reveal = this.phase === 'reveal';
    const knows = p.id === this.drawerId || p.guessed || reveal;
    return {
      t: 'state', you: p.id, host: this.hostId, phase: this.phase,
      round: this.round, rounds: this.settings.rounds, settings: this.settings,
      turn: this.turn, drawer: this.drawerId,
      left: Math.max(0, this.deadline - Date.now()), total: this.total,
      players: [...this.players.values()].map(q => ({
        id: q.id, name: q.name, score: q.score, guessed: q.guessed, connected: q.connected,
        gain: this.gains.get(q.id) || 0,
      })),
      sentence: knows && this.sentence ? this.sentence : undefined,
      hint: this.phase === 'draw' && !knows ? makeHint(this.sentence, this.hintStage) : undefined,
      sugg: this.phase === 'write' && p.id === this.drawerId ? this.sugg : undefined,
    };
  }
  pushState() { for (const p of this.players.values()) if (p.ws) this.send(p.ws, this.view(p)); }

  async onJoin(ws, m) {
    if (ws.joining || ws.pid) return;
    ws.joining = true;
    const fail = (code, msg) => { this.send(ws, { t: 'err', code, msg }); ws.joining = false; };
    if (!this.env.DB) return fail('server', 'خطای سرور.');
    const row = await this.env.DB.prepare('SELECT id,name FROM players WHERE token=?').bind(String(m.token || '')).first();
    if (!row) return fail('unknown', 'نام بازیکن معتبر نیست؛ صفحه را دوباره باز کن.');

    let p = this.players.get(row.id);
    if (p) {                                   // اتصال دوباره‌ی همان بازیکن
      if (p.ws && p.ws !== ws) {
        this.send(p.ws, { t: 'err', code: 'replaced', msg: 'این بازیکن در تب یا دستگاه دیگری وارد اتاق شد. برای تست، در هر تب/دستگاه نام متفاوتی بساز.' });
        try { p.ws.close(4000, 'replaced'); } catch {}
      }
      p.ws = ws; p.connected = true;
    } else {
      if (m.create) { if (this.created && this.connected().length) return fail('exists', 'کد تکراری بود.'); }
      else if (!this.created) return fail('noroom', 'اتاقی با این کد پیدا نشد.');
      if (this.players.size >= MAX_PLAYERS) return fail('full', 'اتاق پر است.');
      p = { id: row.id, name: row.name, score: 0, guessed: false, ws, connected: true, msgAt: 0 };
      this.players.set(p.id, p);
      this.created = true;
      if (!this.players.has(this.hostId) || !this.players.get(this.hostId).connected) this.hostId = p.id;
      if (this.phase !== 'lobby') this.queue.push(p.id);
      this.sys(p.name + ' وارد شد 👋');
    }
    ws.pid = p.id; ws.joining = false;
    if (!this.iv) this.iv = setInterval(() => this.tick(), 1000);
    this.send(ws, this.view(p));
    this.send(ws, { t: 'sync', strokes: this.strokes });
    this.pushState();
  }

  onClose(ws) {
    const p = ws.pid && this.players.get(ws.pid);
    if (!p || p.ws !== ws) return;
    p.ws = null; p.connected = false;
    const wasDrawer = p.id === this.drawerId;
    if (this.phase === 'lobby') this.players.delete(p.id);
    this.sys(p.name + ' خارج شد');
    const left = this.connected();
    if (!left.length) { this.reset(); return; }
    if (this.hostId === p.id) this.hostId = left[0].id;
    if (this.phase !== 'lobby') {
      if (left.length < 2) { this.finishGame('بازیکن‌ها کافی نبودند؛ بازی تمام شد.'); return; }
      if (wasDrawer && (this.phase === 'write' || this.phase === 'draw')) {
        this.sys('نقاش خارج شد.');
        if (this.phase === 'draw') this.endTurn(); else this.nextTurn();
        return;
      }
      if (this.phase === 'draw') { this.checkAllGuessed(); if (this.phase !== 'draw') return; }
    }
    this.pushState();
  }

  /* ---------- پیام‌ها ---------- */
  async onMsg(ws, m) {
    if (m.t === 'join') return this.onJoin(ws, m);
    if (m.t === 'ping') return this.send(ws, { t: 'pong' });
    const p = ws.pid && this.players.get(ws.pid);
    if (!p || p.ws !== ws) return;
    const isDrawer = p.id === this.drawerId;

    switch (m.t) {
      case 'set':
        if (p.id !== this.hostId || this.phase !== 'lobby') return;
        this.settings = { rounds: Math.round(num(m.rounds, 1, 5)), time: Math.round(num(m.time, 30, 180)) };
        return this.pushState();
      case 'start':
        if (p.id !== this.hostId || this.phase !== 'lobby') return;
        if (this.connected().length < 2) return this.send(ws, { t: 'chat', kind: 'sys', text: 'برای شروع حداقل ۲ بازیکن لازم است.' });
        for (const q of this.players.values()) q.score = 0;
        this.resetGame();
        this.sys('بازی شروع شد! 🎨');
        return this.nextTurn();
      case 'sentence':
        if (this.phase !== 'write' || !isDrawer) return;
        {
          const s = cleanText(m.text, 80);
          if (s.length < 6 || wordsOf(s).length < 2) return this.send(ws, { t: 'chat', kind: 'sys', text: 'جمله باید حداقل ۲ کلمه باشد.' });
          return this.startDraw(s);
        }
      case 'sb': {
        if (this.phase !== 'draw' || !isDrawer || this.strokes.length > 600 || this.pts > 40000) return;
        const c = /^#[0-9a-fA-F]{6}$/.test(m.c) ? m.c : '#111111';
        const w = num(m.w, 2, 40), x = num(m.x, 0, 1), y = num(m.y, 0, 1);
        this.strokes.push({ c, w, p: [x, y] }); this.pts++;
        return this.broadcast({ t: 'sb', c, w, x, y }, q => q.id !== p.id);
      }
      case 'sp': {
        if (this.phase !== 'draw' || !isDrawer || !Array.isArray(m.p) || this.pts > 40000) return;
        const last = this.strokes[this.strokes.length - 1];
        if (!last) return;
        const arr = m.p.slice(0, 200).map(v => num(v, 0, 1));
        if (arr.length % 2) arr.pop();
        if (!arr.length) return;
        last.p.push(...arr); this.pts += arr.length / 2;
        return this.broadcast({ t: 'sp', p: arr }, q => q.id !== p.id);
      }
      case 'undo':
        if (this.phase !== 'draw' || !isDrawer) return;
        this.strokes.pop();
        return this.broadcast({ t: 'undo' }, q => q.id !== p.id);
      case 'clear':
        if (this.phase !== 'draw' || !isDrawer) return;
        this.strokes = [];
        return this.broadcast({ t: 'clear' }, q => q.id !== p.id);
      case 'msg':
        return this.onChat(p, m.text);
    }
  }

  onChat(p, raw) {
    const now = Date.now();
    if (now - p.msgAt < 400) return;
    p.msgAt = now;
    const text = cleanText(raw, 140);
    if (!text) return;
    const out = { t: 'chat', kind: 'msg', from: p.id, name: p.name, text };

    if (this.phase === 'draw') {
      if (p.id === this.drawerId) {                         // نقاش نباید جمله را لو بدهد
        const r = matchGuess(text, this.sentence);
        if (r.ok || r.ratio >= 0.7 || r.common >= 0.6) return this.send(p.ws, { t: 'chat', kind: 'sys', text: 'نمی‌تونی جمله رو لو بدی 🙂' });
        return this.broadcast(out);
      }
      if (p.guessed) {                                      // کسانی که حدس زده‌اند فقط با هم و نقاش حرف می‌زنند
        return this.broadcast({ ...out, kind: 'team' }, q => q.guessed || q.id === this.drawerId);
      }
      const r = matchGuess(text, this.sentence);
      if (r.ok) {
        const frac = Math.max(0, (this.deadline - now) / this.total);
        const pts = 100 + Math.round(300 * frac) + (this.guessN === 0 ? 50 : 0);
        this.guessN++; p.guessed = true; p.score += pts;
        this.gains.set(p.id, (this.gains.get(p.id) || 0) + pts);
        const d = this.players.get(this.drawerId);
        if (d) { d.score += 50; this.gains.set(d.id, (this.gains.get(d.id) || 0) + 50); }
        this.sys(p.name + ' جمله را حدس زد! ✅', 'ok');
        this.checkAllGuessed();
        if (this.phase === 'draw') this.pushState();
        return;
      }
      this.broadcast(out);
      if (r.close) this.send(p.ws, { t: 'chat', kind: 'close', text: 'نزدیک شدی! 🔥' });
      return;
    }
    this.broadcast(out);
  }

  /* ---------- جریان بازی ---------- */
  nextTurn() {
    let id = 0;
    while (!id) {
      if (!this.queue.length) {
        if (this.round >= this.settings.rounds) return this.finishGame();
        this.round++;
        this.queue = this.connected().map(p => p.id);
        if (!this.queue.length) return this.finishGame();
      }
      const c = this.queue.shift(), pl = this.players.get(c);
      if (pl && pl.connected) id = c;
    }
    this.drawerId = id; this.sentence = ''; this.strokes = []; this.pts = 0;
    this.guessN = 0; this.hintStage = 0; this.gains = new Map();
    for (const q of this.players.values()) q.guessed = false;
    this.turn++;
    this.phase = 'write';
    this.total = WRITE_MS; this.deadline = Date.now() + this.total;
    this.sugg = pick(SENTENCES, 3);
    this.pushState();
  }

  startDraw(sentence) {
    this.sentence = sentence;
    this.phase = 'draw';
    this.total = this.settings.time * 1000; this.deadline = Date.now() + this.total;
    this.hintStage = 0;
    this.pushState();
  }

  checkAllGuessed() {
    const gs = this.connected().filter(q => q.id !== this.drawerId);
    if (gs.length && gs.every(q => q.guessed)) this.endTurn();
  }

  endTurn() {
    if (this.phase !== 'draw') return;
    this.phase = 'reveal';
    this.total = REVEAL_MS; this.deadline = Date.now() + this.total;
    this.pushState();
  }

  tick() {
    try { this.tick2(); } catch (e) { console.error('draw tick', e && e.stack || e); }
  }
  tick2() {
    const now = Date.now();
    if (this.phase === 'write' && now >= this.deadline) {
      this.sys('جمله‌ای نوشته نشد؛ یک جمله‌ی تصادفی انتخاب شد.');
      this.startDraw(this.sugg[0] || SENTENCES[rnd(SENTENCES.length)]);
    } else if (this.phase === 'draw') {
      if (now >= this.deadline) return this.endTurn();
      const frac = 1 - (this.deadline - now) / this.total;
      const stage = frac >= 0.75 ? 2 : frac >= 0.5 ? 1 : 0;
      if (stage !== this.hintStage) { this.hintStage = stage; this.pushState(); }
    } else if (this.phase === 'reveal' && now >= this.deadline) {
      this.nextTurn();
    }
  }

  finishGame(note) {
    const ranking = [...this.players.values()].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score }));
    this.broadcast({ t: 'end', ranking, note });
    this.save(ranking);
    for (const p of [...this.players.values()]) { if (!p.connected) this.players.delete(p.id); else { p.score = 0; p.guessed = false; } }
    if (!this.players.has(this.hostId)) { const c = this.connected()[0]; this.hostId = c ? c.id : 0; }
    this.resetGame();
    this.pushState();
  }

  // امتیاز بازی به مجموع امتیاز بازیکن در جدول برترین‌ها اضافه می‌شود (تنها داده‌ای که ذخیره می‌شود)
  async save(list) {
    const db = this.env.DB;
    if (!db) return;
    const now = Date.now();
    for (const x of list) {
      if (!(x.score > 0)) continue;
      try {
        await db.prepare(
          `INSERT INTO scores(game,player_id,score,updated_at) VALUES('draw',?,?,?)
           ON CONFLICT(game,player_id) DO UPDATE SET score = score + excluded.score, updated_at = excluded.updated_at`
        ).bind(x.id, Math.min(Math.floor(x.score), 100000), now).run();
      } catch {}
    }
  }
}
