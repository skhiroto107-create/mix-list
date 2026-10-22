// 音源ファイルから BPM とキーを検出する（ブラウザ内で解析・送信なし）
// Essentia.js（WebAssembly）を初回だけ読み込んで使う。
(function () {
  const VENDOR = '/vendor/';
  let ready = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('解析エンジンを読み込めませんでした'));
      document.head.append(s);
    });
  }

  function init() {
    if (!ready) {
      ready = (async () => {
        await loadScript(VENDOR + 'essentia-wasm.web.js');
        await loadScript(VENDOR + 'essentia.js-core.umd.min.js');
        const mod = await window.EssentiaWASM({ locateFile: (p) => VENDOR + p });
        return new window.Essentia(mod);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  // 44.1kHz・モノラルに変換して読み込む
  async function decode(file) {
    const buf = await file.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 44100, 44100);
    const ab = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    }).catch(() => { throw new Error('この形式の音源は読み込めません（mp3・wav・m4a などを選んでください）'); });
    const n = ab.length, chs = ab.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / chs;
    }
    return { data: out, rate: ab.sampleRate, duration: ab.duration };
  }

  // ピッチクラス → Camelot
  const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const MAJ = { 0: '8B', 7: '9B', 2: '10B', 9: '11B', 4: '12B', 11: '1B', 6: '2B', 1: '3B', 8: '4B', 3: '5B', 10: '6B', 5: '7B' };
  const MIN = { 9: '8A', 4: '9A', 11: '10A', 6: '11A', 1: '12A', 8: '1A', 3: '2A', 10: '3A', 5: '4A', 0: '5A', 7: '6A', 2: '7A' };

  async function analyze(file, onStep) {
    onStep && onStep('準備中');
    const es = await init();
    onStep && onStep('読み込み中');
    const { data, rate, duration } = await decode(file);
    // 長い曲は中ほどの最大90秒だけ解析する（速さのため）
    const win = Math.min(data.length, 90 * rate);
    const start = data.length > win ? Math.floor(Math.min(data.length - win, data.length * 0.2)) : 0;
    const seg = data.subarray(start, start + win);
    onStep && onStep('解析中');
    await new Promise((r) => setTimeout(r, 30)); // 画面を更新してから重い処理に入る

    const v = es.arrayToVector(seg);
    let bpm = null, key = '', keyName = '', strength = 0;
    try {
      const r = es.RhythmExtractor2013(v, 208, 'multifeature', 40);
      bpm = r.bpm;
      if (bpm) {
        while (bpm < 70) bpm *= 2;
        while (bpm > 180) bpm /= 2;
        bpm = Math.round(bpm * 10) / 10;
      }
      const k = es.KeyExtractor(v);
      const pc = PC[k.key];
      if (pc != null) {
        key = (k.scale === 'minor' ? MIN : MAJ)[pc] || '';
        keyName = k.key + (k.scale === 'minor' ? 'm' : '');
      }
      strength = k.strength || 0;
    } finally {
      try { v.delete(); } catch (e) { /* noop */ }
    }
    return { bpm, key, keyName, strength, duration };
  }

  // 「アーティスト - 曲名.mp3」から曲名とアーティストを取り出す
  function fromFilename(name) {
    let base = String(name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\s*\d{1,3}[\s.\-_]+/, '').trim();
    const m = base.split(/\s+[-–—]\s+/);
    if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
    return { artist: '', title: base };
  }

  window.MixAnalyze = { analyze, fromFilename, preload: () => init().catch(() => {}) };
})();
