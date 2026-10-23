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

    return res.status(400).json({ error: '不明な操作です' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'エラーが発生しました' });
  }
};
