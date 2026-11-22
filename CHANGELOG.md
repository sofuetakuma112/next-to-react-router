# Changelog

## Unreleased

### Fixed

- A relative `href` (`about`, `../about`) in `next/link`, `router.push()` and `router.replace()` now leads where it did in Next.js. Next.js resolves it against the current page, like a relative URL: `about` on `/team` is `/about`. React Router resolves it against the route the link is rendered in, so the converted link led to `/team/about`. Files whose hrefs may be relative now use a generated `Link` (`app/lib/link.tsx`), and such `router.push()` arguments go through `useResolveHref()`. Hrefs that are known to be absolute keep React Router's `Link` and `navigate()`.

## 0.1.0

Initial release.

- Converts Next.js Pages Router apps written in TypeScript to React Router 8 (framework mode), Vite 8 and React 19.
- Project config file for the parts that need a hand-written replacement.
- npm, pnpm, Yarn (1, and 2+ with `nodeLinker: node-modules`) and Bun.
