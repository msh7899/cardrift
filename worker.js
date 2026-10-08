// Cloudflare Worker (Static Assets + D1)
// مسیرهای /api/* اینجا پردازش می‌شوند و بقیه‌ی درخواست‌ها فایل‌های public/ را برمی‌گردانند.
// نیازمند D1 binding با نام DB

const GAMES = new Set(['drift0','drift1','drift2','drift3','drift4','stack','flip','peng']);
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
      if (!GAMES.has(game) || !Number.isFinite(score) || score <= 0) return json({ error: 'bad' }, 400);
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
