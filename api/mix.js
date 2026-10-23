// MIX LIST の API：曲データの読み込み・保存・削除
// 保存先は Upstash Redis（Lotus PL と同じ方式）。ハッシュ "mixlist:tracks" に 1曲 = 1フィールドで保存する。

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = process.env.ADMIN_PIN || '';
const KEY = 'mixlist:tracks';
const mem = globalThis.__mixMem || (globalThis.__mixMem = new Map()); // 開発用（Redis 未設定時）

async function kv(cmds) {
  if (!KV_URL || !KV_TOKEN) {
    return cmds.map(([op, , a, b]) => {
      if (op === 'HGETALL') return [...mem.entries()].flat();
      if (op === 'HSET') { mem.set(a, b); return 1; }
      if (op === 'HDEL') { mem.delete(a); return 1; }
      return null;
    });
  }
  const r = await fetch(KV_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw Object.assign(new Error('保存先（Redis）に接続できません'), { status: 500 });
  return j.map((x) => (x && 'result' in x ? x.result : null));
}

async function list() {
  const [flat] = await kv([['HGETALL', KEY]]);
  const out = [];
  const arr = Array.isArray(flat) ? flat : [];
  for (let i = 0; i < arr.length; i += 2) {
    try { out.push({ ...JSON.parse(arr[i + 1]), id: arr[i] }); } catch (e) { /* 壊れた行は無視 */ }
  }
  return out;
}

const isId = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(String(s || ''));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function clean(d) {
  const str = (v, n) => String(v ?? '').slice(0, n);
  const num = (v) => (v === null || v === '' || v === undefined || !isFinite(+v) ? null : +v);
  const deck = (x) => ({ title: str(x?.title, 120), artist: str(x?.artist, 120), bpm: num(x?.bpm), key: str(x?.key, 3) });
  const status = ['idea', 'ready', 'posted'].includes(d?.status) ? d.status : 'idea';
  const postDate = /^\d{4}-\d{2}-\d{2}$/.test(d?.postDate || '') ? d.postDate : '';
  // 曲は 1つのマッシュアップに最大8曲（古い a/b 形式も受け付ける）
  const src = Array.isArray(d?.decks) && d.decks.length ? d.decks : [d?.a, d?.b].filter(Boolean);
  const decks = src.slice(0, 8).map(deck);
  return {
    decks, title: str(d?.title, 120), category: str(d?.category, 40).trim(), status, postDate,
    memo: str(d?.memo, 2000), createdAt: num(d?.createdAt) || Date.now(), updatedAt: Date.now(),
  };
}

// ---------- ジャンルの自動判定（無料） ----------
// 1. Apple の楽曲カタログ（iTunes Search API・キー不要・無料）で各曲のジャンルを調べる
// 2. 見つからない曲があり、GEMINI_API_KEY（Google AI Studio・無料枠）があれば AI で推測する
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const RULES = [
  [['アニメ', 'anime'], 'アニソン'],
  [['ボーカロイド', 'vocaloid', 'ボカロ'], 'ボカロ'],
  [['k-pop'], 'K-POP'],
  [['j-pop', '歌謡'], 'J-POP'],
  [['ヒップホップ', 'hip-hop', 'hip hop', 'ラップ', 'rap'], 'ヒップホップ'],
  [['r&b', 'ソウル', 'soul'], 'R&B'],
  [['ハウス', 'house'], 'ハウス'],
  [['テクノ', 'techno'], 'テクノ'],
  [['ダンス', 'dance', 'エレクトロ', 'electronic', 'edm'], 'EDM'],
  [['レゲエ', 'reggae'], 'レゲエ'],
  [['ロック', 'rock', 'オルタナ', 'alternative', 'メタル', 'metal', 'パンク', 'punk'], 'ロック'],
  [['ポップ', 'pop'], '洋楽'],
];
function mapGenre(g) {
  const s = String(g || '').toLowerCase().replace(/／/g, '/');
  for (const [keys, label] of RULES) if (keys.some((k) => s.includes(k))) return label;
  return String(g || '').trim();
}
const norm = (s) => String(s || '').toLowerCase().replace(/[\s・.\-_'"]/g, '');

async function appleGenre(title, artist) {
  const term = encodeURIComponent((title + ' ' + (artist || '')).trim());
  const url = `https://itunes.apple.com/search?term=${term}&country=JP&media=music&entity=song&limit=8&lang=ja_jp`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const results = (j && j.results) || [];
    if (!results.length) return null;
    // 上位の結果で多数決（アーティスト名が一致する結果は重みを大きく）
    const score = {};
    const a = norm(artist);
    results.forEach((x, i) => {
      const g = mapGenre(x.primaryGenreName);
      if (!g) return;
      let w = 1 / (i + 1);
      if (a && norm(x.artistName).includes(a)) w += 3;
      if (norm(x.trackName).startsWith(norm(title))) w += 0.5;
      score[g] = (score[g] || 0) + w;
    });
    const best = Object.entries(score).sort((p, q) => q[1] - p[1])[0];
    return best ? best[0] : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function aiGenre(songs, cats) {
  const prompt =
    'DJが作るマッシュアップに使う曲の一覧です。このマッシュアップ全体を表すジャンルを1つだけ決めてください。\n\n' +
    songs.map(([t, a], i) => `${i + 1}. ${t}${a ? ' / ' + a : ''}`).join('\n') +
    '\n\nルール:\n' +
    '- 日本のSNSで通じる短いジャンル名にする（例: J-POP, K-POP, 洋楽, ヒップホップ, R&B, EDM, ハウス, テクノ, アニソン, ボカロ, ロック, レゲエ）\n' +
    (cats.length ? '- 次の既存カテゴリーに当てはまるなら、その表記をそのまま使う: ' + cats.join(', ') + '\n' : '') +
    '- 曲ごとにジャンルが違う場合は、マッシュアップとして一番しっくりくるものを選ぶ\n' +
    '- 出力は {"genre":"ジャンル名"} のJSONだけ';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 60, temperature: 0 },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try { return String(JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]).genre || '').trim().slice(0, 40) || null; } catch (e) { return null; }
}

async function guessGenre(decks, known) {
  const songs = (Array.isArray(decks) ? decks : []).slice(0, 8)
    .map((d) => [String(d?.title || '').trim().slice(0, 120), String(d?.artist || '').trim().slice(0, 120)])
    .filter(([t]) => t);
  if (!songs.length) throw Object.assign(new Error('曲名を入れてから判定してください'), { status: 400 });
  const cats = (Array.isArray(known) ? known : []).map((c) => String(c).slice(0, 40)).filter(Boolean).slice(0, 50);

  const found = await Promise.all(songs.map(([t, a]) => appleGenre(t, a)));
  let genre = null, source = 'apple';
  const hits = found.filter(Boolean);
  if (hits.length) {
    const cnt = {};
    hits.forEach((g) => { cnt[g] = (cnt[g] || 0) + 1; });
    const top = Math.max(...Object.values(cnt));
    genre = found.find((g) => g && cnt[g] === top); // 同数なら上の曲（DECK A 側）を優先
  }
  if ((!genre || hits.length < songs.length) && GEMINI_KEY) {
    const g = await aiGenre(songs, cats).catch(() => null);
    if (g && (!genre || !hits.length)) { genre = g; source = 'ai'; }
  }
  if (!genre) throw Object.assign(new Error('ジャンルが見つかりませんでした。カテゴリーを手で入力してください'), { status: 404 });
  // 既存カテゴリーと同じものは、その表記にそろえる
  const same = cats.find((c) => norm(c) === norm(genre) || norm(mapGenre(c)) === norm(genre));
  return { genre: same || genre, source };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST のみ対応しています' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (PIN && String(body.pin || '') !== PIN) return res.status(401).json({ error: 'PIN が違います' });

    if (body.action === 'list') return res.json({ tracks: await list() });

    if (body.action === 'save') {
      const id = body.id && isId(body.id) ? body.id : newId();
      const data = clean(body.data);
      await kv([['HSET', KEY, id, JSON.stringify(data)]]);
      return res.json({ ok: true, track: { ...data, id } });
    }

    if (body.action === 'delete') {
      if (!isId(body.id)) return res.status(400).json({ error: 'id が不正です' });
      await kv([['HDEL', KEY, body.id]]);
      return res.json({ ok: true });
    }

    if (body.action === 'genre') return res.json(await guessGenre(body.decks, body.categories));

    return res.status(400).json({ error: '不明な操作です' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'エラーが発生しました' });
  }
};
