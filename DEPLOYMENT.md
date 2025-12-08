# Ace Wing Online - Cloudflare Workers/Pages 移行ガイド

## 🚀 セットアップ手順

### 1. 依存関係のインストール
```bash
npm install
```

### 2. ローカル開発

#### Workersサーバー（WebSocket）の起動
```bash
npm run dev
```
→ `http://localhost:8787` でWorkerが起動します

#### Pagesプレビュー（フロントエンド）
別のターミナルで:
```bash
npm run pages:dev
```
→ `http://localhost:8788` でフロントエンドが起動します

### 3. デプロイ

#### 初回: Cloudflare認証
```bash
npx wrangler login
```

#### Workersのデプロイ（WebSocketサーバー）
```bash
npm run deploy
```

デプロイ後、表示されるURLをメモしてください（例: `https://ace-wing-online.your-subdomain.workers.dev`）

#### script.jsのURL更新
`script.js`の以下の部分を、デプロイしたWorkerのURLに更新:
```javascript
const NET_DEFAULT_URL = window.location.hostname === 'localhost' 
    ? 'ws://localhost:8787/ws' 
    : 'wss://your-worker-name.your-subdomain.workers.dev/ws'; // ← ここを更新
```

#### Pagesのデプロイ（フロントエンド）
```bash
npm run pages:deploy
```

または、GitHubと連携して自動デプロイ:
1. GitHubにプッシュ
2. Cloudflare Dashboard → Pages → "Connect to Git"
3. リポジトリを選択
4. ビルド設定なしでデプロイ（静的ファイルのみ）

## 📁 ファイル構成

```
/
├── src/
│   └── worker.ts          # Hono + Durable Objects サーバー
├── index.html             # フロントエンド
├── script.js              # ゲームロジック（WebSocket接続先を更新済み）
├── style.css              # スタイル
├── wrangler.toml          # Cloudflare Workers設定
├── tsconfig.json          # TypeScript設定
└── package.json           # 依存関係
```

## 🎮 動作確認

1. ローカル: `http://localhost:8788` にアクセス
2. "ONLINE" → "RANDOM MATCH" でマッチング動作を確認
3. 別ブラウザで同じURLにアクセスしてマッチング

## 💰 料金

- **Workers**: 無料枠 100,000リクエスト/日
- **Durable Objects**: 最初の100万リクエストまで無料
- **Pages**: 無料（500ビルド/月）

小〜中規模のゲームなら無料枠で十分運用できます。

## 🔧 トラブルシューティング

### TypeScriptエラーが出る場合
```bash
npm install
```

### Durable Objectsのエラー
`wrangler.toml`のmigrationが正しく設定されているか確認

### WebSocket接続エラー
- ローカル: `ws://localhost:8787/ws`
- 本番: `wss://your-worker.workers.dev/ws` （HTTPSではなくWSS）

## 📝 注意事項

- `server.js`は不要になりました（`src/worker.ts`に置き換え）
- Durable Objectsは地理的に最適な場所に自動配置されます
- WebSocket接続は最大10分間維持されます（自動再接続実装推奨）

## 🌐 本番環境URL更新

デプロイ後、`script.js`の`NET_DEFAULT_URL`を必ず更新してください！
