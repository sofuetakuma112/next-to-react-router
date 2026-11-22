# next-to-react-router

Next.js（Pages Router・TypeScript）のアプリを、Vite 上の [React Router](https://reactrouter.com)（framework mode）に 1 コマンドで変換します。

```sh
npx next-to-react-router
```

ソースの書き換え、`pages/` から `app/routes/` への移動、React Router / Vite の設定の生成、設定ファイルの更新、依存パッケージのインストールまでを行い、最後に自分の結果を検証します（型チェック、本番ビルド、サーバー用ビルドの読み込み）。

[English](./README.md)

## 変換後の構成

| 変換前                  | 変換後                                                       |
| ----------------------- | ------------------------------------------------------------ |
| Next.js（Pages Router） | React Router 8（framework mode、サーバーサイドレンダリング） |
| webpack / Turbopack     | Vite 8                                                       |
| React 18 / 19           | React 19（React Router 8 が必須としている）                  |
| `next start`            | `server.js`（Express。圧縮と静的ファイルのキャッシュつき）   |

URL、サーバー側のデータ取得、画像最適化のエンドポイント、ミドルウェアはそのまま引き継がれます。

## 必要なもの

- Node.js 22.22 以上
- **Pages Router** を使い、**TypeScript** で書かれた Next.js アプリ
- コミットしていない変更がない git の作業ツリー（結果を 1 つの差分としてレビューできるように、変更があると実行しません）

npm・pnpm・Yarn・Bun に対応し、それぞれテストしています。どれを使うかはロックファイルから判定します。Yarn 2 以降は `nodeLinker: node-modules` が必要です（Plug'n'Play のままだと、何も変更する前に止まります）。

## 使い方

```sh
cd my-next-app
npx next-to-react-router
```

| オプション                  |                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `--root <dir>`              | 変換するプロジェクト（既定: カレントディレクトリ）                                       |
| `--config <file>`           | プロジェクトの設定ファイル（既定: プロジェクト直下の `next-to-react-router.config.mjs`） |
| `--skip-install`            | 依存をインストールしない（型の生成・整形・検証もしない）                                 |
| `--skip-verify`             | 変換後の型チェックとビルドをしない                                                       |
| `--allow-dirty`             | コミットしていない変更があっても実行する                                                 |
| `--accept-drift`            | 手で置き換えるファイルの元が変わっていても実行する（下の `replaces`）                    |
| `--ignore-config-key <key>` | `next.config` が変換できない `<key>` を使っていても続ける（複数指定可）                  |
| `--hash <file...>`          | ファイルの内容のハッシュを表示する（`replaces` 用）                                      |

変換後は次のコマンドで動きます。

```sh
npm run dev                      # 開発サーバー
npm run build && npm run start   # 本番（PORT で待ち受けポートを指定。既定 3000）
```

## 変換するもの

| Next.js                                                       | React Router                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pages/**`                                                    | `app/routes/**` と、生成したルート表 `app/routes.ts`                                                              |
| `pages/_app.tsx`・`pages/_document.tsx`                       | `app/root.tsx`                                                                                                    |
| `middleware.ts` / `proxy.ts`                                  | サーバーミドルウェア `app/middleware.server.ts`（`app/root.tsx` から実行）                                        |
| `getServerSideProps`・`getStaticProps`                        | `loader`。`{ props }` は戻り値、`{ redirect }` は `redirect()`、`{ notFound: true }` は 404 の throw              |
| `context.res.setHeader()`・`context.res.statusCode`           | `data(value, { status, headers })`                                                                                |
| `res.end(body)`（サイトマップ・フィード）                     | `new Response(body, { headers })`                                                                                 |
| ページの props                                                | ページが `loaderData` を受け取る                                                                                  |
| `Page.getLayout = …` などページの static                      | `export const handle = { getLayout: … }`                                                                          |
| `next/link`                                                   | `react-router` の `Link`（`href` → `to`、`{ pathname, query }` → `{ pathname, search }`）                         |
| `next/router`                                                 | `useNavigate`・`useLocation` と、生成する小さなフック `useQuery`・`useRoutePattern`                               |
| `next/image`                                                  | 生成する `Image` コンポーネントと、同じパラメータ・同じ制限の `/_image`                                           |
| 画像ファイルの import                                         | Next.js と同じ `{ src, width, height }`                                                                           |
| `next/head`                                                   | そのままの `<title>` / `<meta>` / `<link>`（React 19 が `<head>` に上げる）                                       |
| `next/script`                                                 | 同じ読み込み戦略（`beforeInteractive`・`afterInteractive`・`lazyOnload`）を持つ、生成した `Script` コンポーネント |
| `next/font/google`                                            | [Fontsource](https://fontsource.org) のパッケージ                                                                 |
| `next/dynamic`                                                | `React.lazy` を使う、生成した `dynamic()`                                                                         |
| `process.env.NEXT_PUBLIC_X`                                   | `import.meta.env.VITE_X`（`.env*` も合わせて改名）                                                                |
| `router.pathname` と比べている `'/posts/[id]'` のような文字列 | `'/posts/:id'`                                                                                                    |
| `next.config` の `images`                                     | `app/lib/image-config.ts`                                                                                         |
| React 18 の型                                                 | React 19（`RefObject<T \| null>`、ref コールバックの戻り値、`JSX` 名前空間、`onInput`）                           |

設定ファイルも更新します：`package.json`（依存、スクリプト、`"type": "module"`）、`tsconfig.json`、`.eslintrc.json`（`next` を extends している場合）、`.gitignore`、`.prettierignore`、Tailwind の `content`、プロジェクト直下の CommonJS の設定ファイル（`.cjs` に改名）。

### 変換しないもの

次のものを見つけると、ファイルと行を出して止まります。黙って飛ばすことはありません。

- App Router（`app/`）、React Server Components、Server Actions
- API Routes（`pages/api`）
- JavaScript（`.js` / `.jsx`）のページ、MDX のページ
- `getInitialProps`、`getStaticPaths`、optional catch-all（`[[...slug]]`）
- 国際化ルーティング（`i18n`）、`basePath`、`assetPrefix`
- `next.config` の `redirects`・`rewrites`・`headers`（ミドルウェアとして書き直してから `--ignore-config-key` を付ける）
- ミドルウェアの `NextResponse.rewrite()` と `request.cookies`
- `next/font/local`、`styled-jsx`、`next/navigation`
- `getInitialProps` を持つ `Document` クラスと、`Component` を描画する以外のことをしている `_app`（下の設定ファイルで対応）

`next.config` の `webpack()` は警告を出して無視します。

## プロジェクトの設定ファイル

多くのプロジェクトでは不要です。機械的に変換できない、そのプロジェクト固有の部分があるときに、プロジェクト直下に `next-to-react-router.config.mjs` を置きます。

```js
export default {
    // 生成に任せず、自分で書いたファイルを置く。キー: 変換後の置き場所、値: 用意したファイル（この設定ファイルからの相対パス）
    files: {
        'app/root.tsx': './conversion/root.tsx.tmpl',
    },

    // 上のファイルが置き換える元のファイル。元が変わっていたら codemod は止まる（置き換え側にも同じ変更が要るはず）。
    // ハッシュは `next-to-react-router --hash <file>` で表示できる。
    replaces: {
        'pages/_app.tsx': { sha256: '…', by: 'conversion/root.tsx.tmpl' },
        'pages/_document.tsx': { sha256: '…', by: 'conversion/root.tsx.tmpl' },
    },

    // ページのまとまりをレイアウトルートで包む。include に含まれ exclude に含まれない最初のレイアウトに入る。
    routes: {
        layouts: [{ file: 'docs-layout.tsx', id: 'docs', include: ['/docs'] }],
    },

    // 追加の依存（置き換えたファイルが import するものなど）
    packages: {
        dependencies: { '@fontsource/inter': '^5.0.0' },
    },

    // codemod が中身を理解しないファイルへの、テキストの置換
    textReplacements: [{ files: ['scripts/*.sh'], replacements: [[/\.next\b/g, 'build']] }],

    // 確認済みで、React 19 の `defaultProps` の警告から外すライブラリ
    reviewedLibraries: ['react-modal'],

    // 実行の最後に表示するメモ
    notes: ['CI のシークレットを更新する（NEXT_PUBLIC_* は VITE_* になった）。'],

    // /_next/image を /_image の別名として残す（既定: true）
    legacyImageRoute: true,
};
```

置き換え用のファイルには `.tmpl` のような接尾辞を付けておくと、変換前の Next.js のビルドや型チェックの対象になりません。

## Next.js と同じ動きにするためにしていること

そのまま移すと動きが変わってしまう箇所です。

- **CSS の読み込み順**：React Router は、ルート自身の CSS を共有チャンクの CSS より先に読み込みます。Next.js は import した順に読み込み、スタイルもそれを前提に書かれています（ページが、import したコンポーネントの見た目を上書きする）。生成する `vite-plugin-route-css-order.ts` が import 順に戻します。
- **CSS の圧縮**：Vite 既定の Lightning CSS は、`-webkit-backdrop-filter` と並べて書かれた `backdrop-filter` を消してしまい、Chrome で効果がなくなります。生成する Vite の設定では esbuild で圧縮します。
- **サーバー用ビルド**：公開されている形のままでは Node.js が ES モジュールとして読めない依存があります。検証のときにサーバー用ビルドを読み込み、失敗したパッケージを `ssr.noExternal` に足します。
- **画像最適化**：`/_image` は `/_next/image` と同じ `url`・`w`・`q` を受け取り、同じ許可リストで制限し、同じ方法で出力形式を選びます。公開済みの URL のために `/_next/image` も動き続けます。
- **HTML 以外のレスポンス**：`getServerSideProps` でレスポンスに XML を書いていたページは、変換後も XML を返します（`app/entry.server.tsx` が、loader の HTML 以外の `Response` をそのまま返す）。
- **ミドルウェアのリダイレクト**：Next.js は、ミドルウェアが返した同じホストへのリダイレクトを、相対パスの `Location`（`/login`）で返します。変換後のミドルウェアも同じにします。
- **スクリプト**：`next/script` と同じく、`afterInteractive` はハイドレーション後に、`lazyOnload` は load イベントのあとに `<body>` へ足します。`strategy="worker"` は変換せずに止まります。
- **末尾のスラッシュ**：`/about/` は `/about` にリダイレクトします（308）。`next.config` で `skipTrailingSlashRedirect` か `trailingSlash` を設定している場合は除きます。
- **Strict Mode**：`reactStrictMode` が無効（Pages Router の既定）なら、生成するクライアントのエントリは `<StrictMode>` で包みません。
- **404**：存在しない URL と、loader が「見つからない」と答えた場合は、ステータス 404 で `pages/404` を表示します。

## 変わること

- **すべてのページを、リクエストごとにサーバーで描画します。** Next.js が静的に生成していたページ（データ取得関数がない、または `getStaticProps`）も静的ではなくなります。HTML は、loader が指定しないかぎり `Cache-Control: no-store` で返します。
- **React 19 になります。** peer dependency に React 18 までしか書いていないライブラリには、インストールが通るよう npm の `overrides` を足します。React 19 は関数コンポーネントの `defaultProps` を無視するので、`defaultProps` を代入している依存を一覧で出します。
- **環境変数**：`NEXT_PUBLIC_*` は `VITE_*` になります。リポジトリ内の `.env*` は改名しますが、それ以外の場所（CI、サーバー）は手で改名してください。サーバーだけが読む変数は引き続き `process.env` から読み、`server.js` が起動時に `.env` を読み込みます。
- **すぐ表示する画像が preload されます。** React 19 が、`loading="lazy"` のない画像に `<link rel="preload">` を足します。

## テスト

- `npm test`：変換ごとの単体テストと、2 つのサンプルアプリ（`test/fixtures`）の変換。
- `npm run test:e2e`：サンプルアプリを実際に変換（インストール、型チェック、ビルド）してサーバーを起動し、ページ・リダイレクト・ステータス・ヘッダー・画像のエンドポイントを確認します。基本のサンプルアプリは pnpm・Yarn・Bun でも変換します。

## ライセンス

MIT
