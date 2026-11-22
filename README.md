# next-to-react-router

Converts a Next.js app (Pages Router, TypeScript) to [React Router](https://reactrouter.com) framework mode on Vite, in one command.

```sh
npx next-to-react-router
```

It rewrites the source, moves `pages/` to `app/routes/`, generates the React Router and Vite setup, updates the configuration files, installs the new dependencies, and then checks its own work: type check, production build, and loading the server build in Node.js.

[日本語の説明はこちら](./README.ja.md)

## What you get

| Before                 | After                                                         |
| ---------------------- | ------------------------------------------------------------- |
| Next.js (Pages Router) | React Router 8, framework mode, server-side rendering         |
| webpack / Turbopack    | Vite 8                                                        |
| React 18 or 19         | React 19 (React Router 8 requires it)                         |
| `next start`           | `server.js`: Express with compression and static file caching |

The converted app keeps its URLs, its server-side data loading, its image optimization endpoint and its middleware.

## Requirements

- Node.js 22.22 or newer
- A Next.js app that uses the **Pages Router** and is written in **TypeScript**
- A clean git working tree (the codemod refuses to run otherwise, so the result is one reviewable diff)

npm, pnpm, Yarn and Bun are supported and tested; the package manager is detected from the lockfile. Yarn 2+ needs `nodeLinker: node-modules` (Plug'n'Play is refused before anything is changed).

## Usage

```sh
cd my-next-app
npx next-to-react-router
```

| Option                      |                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `--root <dir>`              | Project to convert (default: current directory)                                      |
| `--config <file>`           | Project config (default: `next-to-react-router.config.mjs` in the project root)      |
| `--skip-install`            | Do not install dependencies. Also skips type generation, formatting and verification |
| `--skip-verify`             | Do not type-check and build after converting                                         |
| `--allow-dirty`             | Run even with uncommitted changes                                                    |
| `--accept-drift`            | Run even if files replaced by hand have changed (see `replaces` below)               |
| `--ignore-config-key <key>` | Proceed although `next.config` uses `<key>`, which is not converted. Repeatable      |
| `--hash <file...>`          | Print the content hash of files, for `replaces`                                      |

Afterwards:

```sh
npm run dev                      # development server
npm run build && npm run start   # production (PORT sets the port, default 3000)
```

## What is converted

| Next.js                                                    | React Router                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/**`                                                 | `app/routes/**` plus a generated route table, `app/routes.ts`                                                                                                                                                                          |
| `pages/_app.tsx`, `pages/_document.tsx`                    | `app/root.tsx`                                                                                                                                                                                                                         |
| `middleware.ts` / `proxy.ts`                               | A server middleware, `app/middleware.server.ts`, run from `app/root.tsx`                                                                                                                                                               |
| `getServerSideProps`, `getStaticProps`                     | `loader`. `{ props }` becomes the return value, `{ redirect }` a `redirect()`, `{ notFound: true }` a thrown 404                                                                                                                       |
| `context.res.setHeader()`, `context.res.statusCode`        | `data(value, { status, headers })`                                                                                                                                                                                                     |
| `res.end(body)` (sitemaps, feeds)                          | `new Response(body, { headers })`                                                                                                                                                                                                      |
| Page props                                                 | The page receives `loaderData`                                                                                                                                                                                                         |
| `Page.getLayout = …` and other page statics                | `export const handle = { getLayout: … }`                                                                                                                                                                                               |
| `next/link`                                                | `Link` from `react-router` (`href` → `to`, `{ pathname, query }` → `{ pathname, search }`). Where an `href` may be a relative path (`about`, `../about`), a generated `Link` that resolves it against the current page, as Next.js did |
| `next/router`                                              | `useNavigate`, `useLocation`, and small generated hooks: `useQuery`, `useRoutePattern`, and `useResolveHref` for a `router.push()` path that may be relative                                                                           |
| `next/image`                                               | A generated `Image` component and a `/_image` endpoint with the same parameters and limits                                                                                                                                             |
| Image file imports                                         | `{ src, width, height }`, as Next.js provides them                                                                                                                                                                                     |
| `next/head`                                                | Plain `<title>` / `<meta>` / `<link>`: React 19 hoists them into `<head>`                                                                                                                                                              |
| `next/script`                                              | A generated `Script` component with the same strategies (`beforeInteractive`, `afterInteractive`, `lazyOnload`)                                                                                                                        |
| `next/font/google`                                         | [Fontsource](https://fontsource.org) packages                                                                                                                                                                                          |
| `next/dynamic`                                             | A generated `dynamic()` helper on top of `React.lazy`                                                                                                                                                                                  |
| `process.env.NEXT_PUBLIC_X`                                | `import.meta.env.VITE_X` (`.env*` files are renamed to match)                                                                                                                                                                          |
| `'/posts/[id]'` in strings compared with `router.pathname` | `'/posts/:id'`                                                                                                                                                                                                                         |
| `images` in `next.config`                                  | `app/lib/image-config.ts`                                                                                                                                                                                                              |
| React 18 types                                             | React 19: `RefObject<T \| null>`, ref callback return values, the `JSX` namespace, `onInput`                                                                                                                                           |

Configuration files are updated too: `package.json` (dependencies, scripts, `"type": "module"`), `tsconfig.json`, `.eslintrc.json` (when it extends `next`), `.gitignore`, `.prettierignore`, the Tailwind `content` globs, and CommonJS config files in the project root (renamed to `.cjs`).

### Not converted

The codemod stops with the file and line when it meets one of these. It never skips something silently.

- The App Router (`app/`), React Server Components, Server Actions
- API Routes (`pages/api`)
- JavaScript pages (`.js` / `.jsx`) and MDX pages
- `getInitialProps`, `getStaticPaths`, optional catch-all routes (`[[...slug]]`)
- Internationalized routing (`i18n`), `basePath`, `assetPrefix`
- `redirects`, `rewrites` and `headers` in `next.config` (reimplement them as a middleware, then pass `--ignore-config-key`)
- `NextResponse.rewrite()` and `request.cookies` in middleware
- `next/font/local`, `styled-jsx`, `next/navigation`
- A custom `Document` class with `getInitialProps`, and `_app` components that do more with `Component` than render it (see the config file below)

A custom `webpack()` function in `next.config` is ignored, with a warning.

## The project config file

Most projects need none. When part of a project is too specific to convert mechanically, put a `next-to-react-router.config.mjs` in the project root:

```js
export default {
    // Write these files yourself instead of having them generated.
    // Key: destination in the converted project. Value: your file, relative to this config.
    files: {
        'app/root.tsx': './conversion/root.tsx.tmpl',
    },

    // The source files your replacements stand in for. If one of them changes, the codemod stops:
    // the replacement probably needs the same change. `next-to-react-router --hash <file>` prints the hash.
    replaces: {
        'pages/_app.tsx': { sha256: '…', by: 'conversion/root.tsx.tmpl' },
        'pages/_document.tsx': { sha256: '…', by: 'conversion/root.tsx.tmpl' },
    },

    // Wrap groups of pages in layout routes. A page goes into the first layout that includes
    // and does not exclude it; patterns cover the route and everything below it.
    routes: {
        layouts: [{ file: 'docs-layout.tsx', id: 'docs', include: ['/docs'] }],
    },

    // Extra dependencies (for example, ones your replacement files import).
    packages: {
        dependencies: { '@fontsource/inter': '^5.0.0' },
    },

    // Plain-text replacements in files the codemod does not understand.
    textReplacements: [{ files: ['scripts/*.sh'], replacements: [[/\.next\b/g, 'build']] }],

    // Libraries you have checked, to leave out of the React 19 `defaultProps` warning.
    reviewedLibraries: ['react-modal'],

    // Printed at the end of the run.
    notes: ['Update the CI secrets: NEXT_PUBLIC_* is now VITE_*.'],

    // Keep serving /_next/image as an alias of /_image (default: true).
    legacyImageRoute: true,
};
```

Give replacement files a suffix such as `.tmpl`, so the Next.js build and the type checker do not pick them up before the conversion.

## Things it does so the result behaves like the Next.js app

These are the places where a straightforward port would have changed behaviour.

- **CSS order.** React Router links a route's own CSS before the CSS of shared chunks. Next.js loads CSS in import order, and stylesheets are written with that in mind (a page overrides a component it imports). The generated `vite-plugin-route-css-order.ts` restores import order.
- **CSS minification.** Vite's default minifier, Lightning CSS, removes `backdrop-filter` where a stylesheet also has `-webkit-backdrop-filter`, which turns the effect off in Chrome. The generated Vite config minifies with esbuild instead.
- **Server build.** Some dependencies cannot be loaded by Node.js as ES modules as published. During verification the codemod loads the server build, and adds each package that fails to `ssr.noExternal`.
- **Image optimization.** `/_image` accepts the same `url`, `w` and `q` parameters as `/_next/image`, enforces the same allow-lists, and negotiates the output format the same way. `/_next/image` keeps working for URLs that are already published.
- **Responses that are not HTML.** A page whose `getServerSideProps` wrote XML to the response still answers with XML: `app/entry.server.tsx` passes a loader's non-HTML `Response` through.
- **Middleware redirects.** Next.js sends a redirect that the middleware returns to the same host with a relative `Location` (`/login`). The converted middleware does the same.
- **Scripts.** `afterInteractive` scripts are added to `<body>` after hydration and `lazyOnload` ones after the load event, as with `next/script`; `strategy="worker"` is refused.
- **Trailing slashes.** `/about/` redirects to `/about` (308), unless `next.config` set `skipTrailingSlashRedirect` or `trailingSlash`.
- **Strict mode.** With `reactStrictMode` off (the Pages Router default), the generated client entry does not wrap the app in `<StrictMode>`.
- **404.** Unknown URLs and loaders that answer "not found" render `pages/404`, with status 404.

## What changes

- **Every page is rendered on the server for each request.** Pages that Next.js generated statically (no data function, or `getStaticProps`) are no longer static. HTML responses are sent with `Cache-Control: no-store` unless a loader sets its own.
- **React 19.** Libraries that only declare React 18 as a peer dependency get an npm `override`, so the install succeeds. React 19 ignores `defaultProps` on function components; the codemod lists dependencies that assign `defaultProps` so you can check them.
- **Environment variables.** `NEXT_PUBLIC_*` becomes `VITE_*`. The codemod renames them in the repository's `.env*` files; rename them yourself wherever else they are defined (CI, servers). Server-only variables are still read from `process.env`; `server.js` loads `.env` at start.
- **Eager images are preloaded.** React 19 adds `<link rel="preload">` for images rendered without `loading="lazy"`.

## How it is tested

- Unit tests for each transform, and conversions of two fixture apps (`test/fixtures`), run with `npm test`.
- `npm run test:e2e` converts the fixtures for real (install, type check, build), starts the server, and checks pages, redirects, status codes, headers and the image endpoint. The basic fixture is also converted with pnpm, Yarn and Bun.

## License

MIT
