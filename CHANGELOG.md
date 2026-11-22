# Changelog

## Unreleased

### Fixed

- A relative `href` (`about`, `../about`) in `next/link`, `router.push()` and `router.replace()` now leads where it did in Next.js. Next.js resolves it against the current page, like a relative URL: `about` on `/team` is `/about`. React Router resolves it against the route the link is rendered in, so the converted link led to `/team/about`. Files whose hrefs may be relative now use a generated `Link` (`app/lib/link.tsx`), and such `router.push()` arguments go through `useResolveHref()`. Hrefs that are known to be absolute keep React Router's `Link` and `navigate()`.
- A `{ pathname, query }` object that reaches `<Link href>` or `router.push()` through a function or a constant (`<Link href={chatRoute()}>`) is now converted to `{ pathname, search }`. React Router ignores `query`, so the query string was dropped. Such objects in another file are reported.
- Routes are matched case-sensitively, as in Next.js. `/About` was served as `/about` instead of a 404.
- `/_image` converts to WebP or AVIF only when the `Accept` header names the format, as Next.js does. Clients that send `Accept: */*`, such as link preview crawlers fetching `og:image`, got WebP they may not support.
- The generated `app/root.tsx` uses a `ScrollRestoration` (`app/lib/scroll-restoration.tsx`) that keeps restoring the position on back/forward navigation and reload until the page is tall enough. Pages that load their content in the browser opened at the top.

## 0.1.0

Initial release.

- Converts Next.js Pages Router apps written in TypeScript to React Router 8 (framework mode), Vite 8 and React 19.
- Project config file for the parts that need a hand-written replacement.
- npm, pnpm, Yarn (1, and 2+ with `nodeLinker: node-modules`) and Bun.
