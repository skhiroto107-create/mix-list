// 動画のアップロード用トークンを発行する（ブラウザから Vercel Blob に直接アップロード）
const { handleUpload } = require('@vercel/blob/client');

const PIN = process.env.ADMIN_PIN || '';
const MAX = 500 * 1024 * 1024; // 1本 500MB まで

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST のみ対応しています' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: '動画の保存先（Vercel Blob）がまだ設定されていません' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (PIN && String(clientPayload || '') !== PIN) throw new Error('PIN が違います');
        if (!/^mix-list\/videos\//.test(pathname)) throw new Error('保存先が正しくありません');
        return { allowedContentTypes: ['video/*'], maximumSizeInBytes: MAX, addRandomSuffix: true };
      },
    });
    return res.json(json);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'アップロードを準備できませんでした' });
  }
};
