# MIX LIST（Vercel 版）

DJ マッシュアップ投稿の管理アプリ。スマホと PC で同じデータを使えます（Upstash Redis に保存）。

| 機能 | 内容 |
|---|---|
| 曲の登録 | 1つのマッシュアップに2〜8曲（DECK A〜H）。曲名・アーティスト・BPM・キー（Camelot）、マッシュアップ名、投稿日、メモ |
| 自動検出 | 各曲の「音源から検出」で音源ファイルを選ぶと、BPM とキーを自動入力（ブラウザ内で解析・音源は送信しない）。ファイル名「アーティスト - 曲名」から曲名も入る |
| 相性チェック | DECK A と各曲のキー（同じ・隣接・平行調）と BPM 差（倍テン・半テン込み） |
| ステータス | アイデア › 完成 › 投稿済み をタップで切り替え |
| 投稿状況 | 連続投稿日数・ストック数・今月の投稿数、月カレンダー |
| 同期 | 開いたとき・画面に戻ったとき・20秒ごとに最新を読み込み |

## セットアップ（約10分）
1. Vercel で **Add New → Project** → GitHub の `mix-list` リポジトリを取り込み → **Deploy**。
2. プロジェクトの **Storage → Create Database → Upstash（Redis）** を作成して、このプロジェクトに接続。
   → `KV_REST_API_URL` と `KV_REST_API_TOKEN` が自動で入ります（無料枠で十分です）。
3. **Settings → Environment Variables** に `ADMIN_PIN`（例：4桁の数字）を追加。
   - 設定しないと URL を知っている人は誰でも見たり編集したりできてしまうので、必ず設定してください。
4. **Deployments → 最新の … → Redeploy**（環境変数を反映するため）。
5. スマホの Safari で開いて PIN を入力 → 共有 → **ホーム画面に追加**。黒いアイコンで追加されます。
6. PC のブラウザでも同じ URL を開いて PIN を入力すれば、同じデータが表示されます。

## ファイル構成
```
index.html             画面
analyze.js             音源ファイルから BPM・キーを検出
vendor/                解析エンジン（Essentia.js）
api/mix.js             読み込み・保存・削除の API（Upstash Redis のハッシュ mixlist:tracks）
manifest.webmanifest   ホーム画面用の設定
icons/                 アイコン（黒地に白の2つの輪）
```
