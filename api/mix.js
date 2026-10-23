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
      if (op === 'HGET') return mem.has(a) ? mem.get(a) : null;
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

// ---------- 動画（Vercel Blob） ----------
const isBlobUrl = (u) => /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//i.test(String(u || ''));
async function delBlob(url) {
  if (!isBlobUrl(url) || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try { const { del } = require('@vercel/blob'); await del(url); } catch (e) { /* 削除できなくても保存は続ける */ }
}
async function getTrack(id) {
  const [v] = await kv([['HGET', KEY, id]]);
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
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
  const v = d?.video;
  const video = v && isBlobUrl(v.url) ? { url: String(v.url).slice(0, 500), name: str(v.name, 200), size: num(v.size), type: str(v.type, 60) } : null;
  return {
    decks, video, title: str(d?.title, 120), category: str(d?.category, 40).trim(), status, postDate,
    memo: str(d?.memo, 2000), createdAt: num(d?.createdAt) || Date.now(), updatedAt: Date.now(),
  };
}

// ---------- ジャンルの自動判定（無料） ----------
// 1. Apple の楽曲カタログ（iTunes Search API・キー不要・無料）で各曲のジャンルを調べる
// 2. 細かいジャンルは MusicBrainz、見つからなければ GEMINI_API_KEY（任意・無料枠）か Apple の大きい分類
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

// ---------- 細かいジャンル（MusicBrainz・無料・キー不要） ----------
const MB = 'https://musicbrainz.org/ws/2/';
const MB_UA = 'MixList/1.0 (https://mix-list.vercel.app)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mbLast = 0;
async function mb(path, retry = 1) {
  const j = await mbOnce(path);
  if (j === 'busy' && retry > 0) { await sleep(1500); return mb(path, retry - 1); }
  return j === 'busy' ? null : j;
}
async function mbOnce(path) {
  // MusicBrainz は 1秒に1回まで
  const wait = mbLast + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  mbLast = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(MB + path + (path.includes('?') ? '&' : '?') + 'fmt=json', { headers: { 'User-Agent': MB_UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (r.status === 503 || r.status === 429) return 'busy';
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (e) { return null; } finally { clearTimeout(t); }
}
const q = (s) => '"' + String(s).replace(/["\\]/g, ' ').trim() + '"';
// 広すぎるジャンル（細かいものがあればそちらを優先）
const BROAD = new Set(['pop', 'rock', 'electronic', 'dance', 'hip hop', 'rap', 'edm', 'j-pop', 'k-pop', 'j-rock', 'house', 'r&b', 'soul', 'jazz', 'alternative', 'indie', 'dance-pop', 'pop rock', 'electropop', 'singer-songwriter', 'club', 'electronica', 'electro', 'urban', 'world', 'asian music', 'pop music']);
const ALIAS = { kpop: 'k-pop', jpop: 'j-pop', jrock: 'j-rock', 'hip-hop': 'hip hop', rnb: 'r&b', 'drum n bass': 'drum and bass', dnb: 'drum and bass', 'lofi': 'lo-fi', 'lo fi': 'lo-fi', 'synthpop': 'synth-pop', 'anime song': 'anime', anisong: 'anime' };
const canon = (g) => { g = g.replace(/ music$/, '').trim(); return ALIAS[g] || g; };
const JUNK = /singer|japan|seen live|favou?rite|bookmark|fixme|auto|\bgen\b|group|female|male|vocal|throwback|idol|^\d|seiyuu|composer|producer|dj$|usa|uk$|korea|american|british|label/i;
const PRETTY = { 'anime': 'アニソン', 'vocaloid': 'ボカロ', 'j-pop': 'J-POP', 'k-pop': 'K-POP', 'j-rock': 'J-ROCK', 'edm': 'EDM', 'r&b': 'R&B', 'uk garage': 'UK Garage', 'uk drill': 'UK Drill', 'drum and bass': 'Drum & Bass', 'idm': 'IDM', 'lo-fi hip hop': 'Lo-fi Hip Hop' };
const pretty = (g) => PRETTY[g] || g.replace(/(^|[\s\-/])([a-z])/g, (m, p1, c) => p1 + c.toUpperCase()).replace(/\bUk\b/g, 'UK').replace(/\bRnb\b/g, 'R&B');

async function artistGenres(title, artist) {
  let id = null, extra = [];
  if (artist) {
    const j = await mb('artist?limit=1&query=' + encodeURIComponent('artist:' + q(artist)));
    const x = j && j.artists && j.artists[0];
    if (x && (x.score || 0) >= 80) { id = x.id; extra = x.tags || []; }
  }
  if (!id && title) {
    const j = await mb('recording?limit=3&query=' + encodeURIComponent('recording:' + q(title) + (artist ? ' AND artist:' + q(artist) : '')));
    const x = j && j.recordings && j.recordings.find((r) => (r.score || 0) >= 80);
    if (x && x['artist-credit'] && x['artist-credit'][0]) id = x['artist-credit'][0].artist.id;
  }
  if (!id) return [];
  const j = await mb('artist/' + id + '?inc=genres+tags');
  if (!j) return [];
  const gs = (j.genres || []).slice().sort((a, b) => b.count - a.count).map((g) => canon(g.name.toLowerCase()));
  const ts = [...(j.tags || []), ...extra].slice().sort((a, b) => b.count - a.count).map((t) => canon(t.name.toLowerCase())).filter((t) => !JUNK.test(t));
  const all = [...new Set([...gs, ...ts])].filter((g) => !JUNK.test(g) && g.length <= 30);
  // 細かいジャンルを先に、広いジャンルを後に
  return [...all.filter((g) => !BROAD.has(g)), ...all.filter((g) => BROAD.has(g))];
}

async function aiGenre(songs, cats) {
  const prompt =
    'DJが作るマッシュアップに使う曲の一覧です。このマッシュアップ全体を表すジャンルを1つだけ、できるだけ細かいサブジャンルで決めてください（例: Future Bass, Tech House, City Pop, UK Garage, Jersey Club, Phonk, Drill, Amapiano, Boom Bap）。\n\n' +
    songs.map(([t, a], i) => `${i + 1}. ${t}${a ? ' / ' + a : ''}`).join('\n') +
    '\n\n' + (cats.length ? '既存カテゴリーに当てはまるなら、その表記をそのまま使う: ' + cats.join(', ') + '\n' : '') +
    '出力は {"genre":"ジャンル名"} のJSONだけ';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 60, temperature: 0 } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try { return String(JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]).genre || '').trim().slice(0, 40) || null; } catch (e) { return null; }
}

async function guessGenre(decks, known) {
  const songs = (Array.isArray(decks) ? decks : []).slice(0, 6)
    .map((d) => [String(d?.title || '').trim().slice(0, 120), String(d?.artist || '').trim().slice(0, 120)])
    .filter(([t]) => t);
  if (!songs.length) throw Object.assign(new Error('曲名を入れてから判定してください'), { status: 400 });
  const cats = (Array.isArray(known) ? known : []).map((c) => String(c).slice(0, 40)).filter(Boolean).slice(0, 50);

  // 1. MusicBrainz（同じアーティストは1回だけ調べる）
  const lists = [];
  const seen = {};
  for (const [t, a] of songs.slice(0, 4)) {
    const k = a ? 'a:' + norm(a) : 't:' + norm(t);
    if (!seen[k]) seen[k] = await artistGenres(t, a);
    lists.push(seen[k]);
  }
  const cand = [];
  // 複数の曲に共通する細かいジャンルを最優先、次に各曲（DECK A から）の上位
  const cnt = {};
  lists.forEach((l) => new Set(l).forEach((g) => { cnt[g] = (cnt[g] || 0) + 1; }));
  const shared = Object.keys(cnt).filter((g) => cnt[g] > 1 && !BROAD.has(g)).sort((x, y) => cnt[y] - cnt[x]);
  // すでに使っているカテゴリーに当てはまるものを最優先（表記ゆれ・絞り込みの分散を防ぐ）
  const all = new Set(lists.flat().map((g) => norm(pretty(g))));
  cand.push(...cats.filter((c) => all.has(norm(c))));
  cand.push(...shared.map(pretty));
  for (let i = 0; i < 4; i++) lists.forEach((l) => { if (l[i]) cand.push(pretty(l[i])); });
  let candidates = [...new Set(cand)];
  let source = 'musicbrainz';

  // 2. 見つからなければ AI（任意）→ Apple（大きい分類）
  if (!candidates.length && GEMINI_KEY) {
    const g = await aiGenre(songs, cats).catch(() => null);
    if (g) { candidates = [g]; source = 'ai'; }
  }
  if (!candidates.length) {
    const found = (await Promise.all(songs.map(([t, a]) => appleGenre(t, a)))).filter(Boolean);
    if (found.length) { candidates = [...new Set(found)]; source = 'apple'; }
  }
  if (!candidates.length) throw Object.assign(new Error('ジャンルが見つかりませんでした。カテゴリーを手で入力してください'), { status: 404 });

  // 既存カテゴリーと同じものは、その表記にそろえる
  const fix = (g) => cats.find((c) => norm(c) === norm(g)) || g;
  candidates = [...new Set(candidates.map(fix))].slice(0, 8);
  return { genre: candidates[0], candidates, source };
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
      const old = body.id ? await getTrack(id) : null;
      await kv([['HSET', KEY, id, JSON.stringify(data)]]);
      // 動画を差し替え・外したら古い動画を消す（無料枠 1GB を節約）
      if (old && old.video && old.video.url !== (data.video && data.video.url)) await delBlob(old.video.url);
      return res.json({ ok: true, track: { ...data, id } });
    }

    if (body.action === 'delete') {
      if (!isId(body.id)) return res.status(400).json({ error: 'id が不正です' });
      const old = await getTrack(body.id);
      await kv([['HDEL', KEY, body.id]]);
      if (old && old.video) await delBlob(old.video.url);
      return res.json({ ok: true });
    }

    // 保存せずに閉じたときのアップロード済み動画を片付ける（どのMixにも使われていない場合だけ）
    if (body.action === 'discard') {
      const urls = (Array.isArray(body.urls) ? body.urls : []).filter(isBlobUrl).slice(0, 10);
      const used = new Set((await list()).map((t) => t.video && t.video.url).filter(Boolean));
      for (const u of urls) if (!used.has(u)) await delBlob(u);
      return res.json({ ok: true });
    }

    if (body.action === 'genre') return res.json(await guessGenre(body.decks, body.categories));

    return res.status(400).json({ error: '不明な操作です' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'エラーが発生しました' });
  }
};
