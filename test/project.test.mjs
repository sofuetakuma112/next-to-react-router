import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../lib/config.mjs';
import { createContext } from '../lib/context.mjs';
import { rewriteImportsAfterMove } from '../lib/move.mjs';
import { collectPageRoutes, renderRoutesFile, toRouterPattern } from '../lib/routes.mjs';
import { buildRootFile, collectPageTypeNames } from '../lib/transforms/app-shell.mjs';
import { cli, copyFixture, createProject, fakeContext, packageDir, squash } from './helpers.mjs';

function tempProject(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-to-react-router-test-'));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

function convert(dir, ...args) {
    return spawnSync(process.execPath, [cli, '--root', dir, ...args], { encoding: 'utf8' });
}

test('routes: page files map to React Router paths', () => {
    const dir = tempProject({
        'pages/_app.tsx': '',
        'pages/index.tsx': '',
        'pages/about.tsx': '',
        'pages/posts/[id]/index.tsx': '',
        'pages/docs/[...path].tsx': '',
        'pages/feed.xml.tsx': '',
        'pages/posts/list.module.css': '',
    });
    const routes = collectPageRoutes(path.join(dir, 'pages'));
    assert.deepEqual(
        routes.map((route) => [route.file, route.path, route.pattern, route.index]),
        [
            ['about.tsx', 'about', '/about', false],
            ['docs/[...path].tsx', 'docs/*', '/docs/*', false],
            ['feed.xml.tsx', 'feed.xml', '/feed.xml', false],
            ['index.tsx', '', '/', true],
            ['posts/[id]/index.tsx', 'posts/:id', '/posts/:id', false],
        ]
    );
    assert.equal(toRouterPattern('/a/[b]/[...c]'), '/a/:b/*');
});

test('routes: API routes and optional catch-alls are rejected', () => {
    assert.throws(() => collectPageRoutes(path.join(tempProject({ 'pages/api/hello.ts': '' }), 'pages')), /API Routes/);
    assert.throws(() => collectPageRoutes(path.join(tempProject({ 'pages/[[...slug]].tsx': '' }), 'pages')), /catch-all/);
});

test('routes: layouts group pages, the 404 page also handles unknown URLs', () => {
    const routes = [
        { file: 'index.tsx', path: '', pattern: '/', index: true },
        { file: '404.tsx', path: '404', pattern: '/404', index: false },
        { file: 'blog/index.tsx', path: 'blog', pattern: '/blog', index: false },
        { file: 'blog/[id].tsx', path: 'blog/:id', pattern: '/blog/:id', index: false },
    ];
    const output = renderRoutesFile(routes, { layouts: [{ file: 'main-layout.tsx', exclude: ['/blog'] }], notFoundPage: routes[1] });
    assert.match(output, /import \{ type RouteConfig, index, layout, route \} from '@react-router\/dev\/routes';/);
    assert.match(
        squash(output),
        /layout\('main-layout\.tsx', \{ id: 'main-layout' \}, \[ index\('routes\/index\.tsx', \{ id: '\/' \}\), route\('404', 'routes\/404\.tsx', \{ id: '\/404' \}\), \/\/ [^\n]*? route\('\*', 'routes\/404\.tsx', \{ id: '\/\*' \}\), \]\), route\('blog', 'routes\/blog\/index\.tsx', \{ id: '\/blog' \}\), route\('blog\/:id'/
    );
    const flat = renderRoutesFile(routes.slice(0, 1), {});
    assert.match(flat, /import \{ type RouteConfig, index \} from/);
});

test('context: src/ layout, path aliases, package manager', () => {
    const dir = tempProject({
        'package.json': '{}',
        'pnpm-lock.yaml': '',
        'tsconfig.json':
            '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], "~lib/*": ["./src/lib/*"] } } /* comment */ }',
        'src/pages/index.tsx': '',
    });
    const context = createContext({ root: dir, packageDir: path.join(dir, 'tools/codemod'), options: {}, config: { value: {} } });
    assert.equal(context.appDirRelative, 'src/app');
    assert.equal(context.packageManager, 'pnpm');
    assert.equal(context.packageDirInProject, 'tools/codemod');
    assert.equal(context.specifier(path.join(dir, 'src/components/a.tsx'), context.modulePath('navigation')), '@/app/lib/navigation');
    assert.equal(context.specifier(path.join(dir, 'src/components/a.tsx'), path.join(dir, 'src/lib/x')), '~lib/x');
    assert.equal(context.specifier(path.join(dir, 'scripts/a.ts'), path.join(dir, 'scripts/b')), './b');
    assert.equal(context.resolveSpecifier(path.join(dir, 'src/a.tsx'), '@/pages/_app'), path.join(dir, 'src/pages/_app'));
});

test('move: imports are fixed after pages/ moves to app/routes/', () => {
    const dir = tempProject({
        'package.json': '{}',
        'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }',
        'pages/index.tsx': '',
        'app/routes/posts/[id].tsx':
            "import a from '../../components/a';\nimport b from '../shared';\nimport c from '@/pages/shared';\nimport './[id].scss';\n",
        'app/routes/posts/[id].scss': "@use '../../styles/mixins';\n.a { background: url('../../public/a.png'); }\n",
        'app/routes/shared.ts': '',
        'components/a.tsx':
            "import { helper } from '../pages/shared';\nimport { other } from '@/pages/posts/[id]';\nimport x from 'lodash';\n",
    });
    const context = createContext({ root: dir, packageDir, options: {}, config: { value: {} } });
    rewriteImportsAfterMove(context, path.join(dir, 'pages'), path.join(dir, 'app/routes'));
    const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(
        read('app/routes/posts/[id].tsx'),
        "import a from '../../../components/a';\nimport b from '../shared';\nimport c from '@/app/routes/shared';\nimport './[id].scss';\n"
    );
    assert.equal(read('app/routes/posts/[id].scss'), "@use '../../../styles/mixins';\n.a { background: url('../../../public/a.png'); }\n");
    assert.equal(
        read('components/a.tsx'),
        "import { helper } from '../app/routes/shared';\nimport { other } from '@/app/routes/posts/[id]';\nimport x from 'lodash';\n"
    );
});

test('app shell: _app and _document become app/root.tsx', () => {
    const project = createProject();
    const appFile = project.createSourceFile(
        '/project/pages/_app.tsx',
        `import type { AppProps } from 'next/app';
import type { NextPage } from 'next';
import '../styles/globals.css';
import { Providers } from '../components/Providers';
export type NextPageWithLayout = NextPage & { getLayout?: (page: React.ReactElement) => React.ReactNode };
type Props = AppProps & { Component: NextPageWithLayout };
export default function MyApp({ Component, pageProps }: Props) {
    const getLayout = Component.getLayout ?? ((page) => page);
    return <Providers session={pageProps.session}>{getLayout(<Component {...pageProps} />)}</Providers>;
}`
    );
    const documentFile = project.createSourceFile(
        '/project/pages/_document.tsx',
        `import { Html, Head, Main, NextScript } from 'next/document';
export default function Document() {
    return (
        <Html lang="ja">
            <Head>
                <link rel="icon" href="/favicon.ico" />
            </Head>
            <body className="app">
                <Main />
                <NextScript />
            </body>
        </Html>
    );
}`
    );
    assert.deepEqual([...collectPageTypeNames(appFile)].sort(), ['NextPage', 'NextPageWithLayout']);
    const root = buildRootFile(project, fakeContext({ specifier: (from, target) => `./${path.relative('/project/app', target)}` }), {
        appFile,
        documentFile,
        middleware: [{ name: 'middleware', file: '/project/app/middleware.server' }],
        notFoundPage: null,
    });
    const text = squash(root.getFullText());
    assert.equal(root.getFilePath(), '/project/app/root.tsx');
    assert.match(text, /import '\.\.\/styles\/globals\.css';/);
    assert.match(text, /import \{ Providers \} from '\.\.\/components\/Providers';/);
    assert.match(text, /import \{ middleware as requestMiddleware \} from '\.\/middleware\.server';/);
    assert.match(text, /export const middleware = \[requestMiddleware\];/);
    assert.match(
        text,
        /<html lang="ja"> <head> <meta charSet="utf-8" \/> <meta name="viewport" content="width=device-width" \/> <Meta \/> <Links \/> <link rel="icon" href="\/favicon\.ico" \/> <\/head>/
    );
    assert.match(text, /<body className="app"> \{children\} <ScrollRestoration \/> <Scripts \/> <\/body>/);
    assert.match(
        text,
        /function MyApp\(\) \{ const matches = useMatches\(\); const leaf = matches\[matches\.length - 1\]; const handle = leaf\?\.handle as RouteHandle \| undefined; const pageProps = \(leaf\?\.loaderData \?\? \{\}\) as Record<string, any>;/
    );
    assert.match(text, /const getLayout = handle\?\.getLayout \?\? \(\(page\) => page\);/);
    assert.match(text, /<Providers session=\{pageProps\.session\}>\{getLayout\(<Outlet \/>\)\}<\/Providers>/);
    assert.match(text, /export default MyApp;/);
    assert.doesNotMatch(text, /from 'next|AppProps|NextPageWithLayout/);
});

test('app shell: without _app and _document a default root is written', () => {
    const root = buildRootFile(createProject(), fakeContext(), { middleware: [] });
    const text = squash(root.getFullText());
    assert.match(text, /export default function App\(\) \{ return <Outlet \/>; \}/);
    assert.match(text, /<html> <head>/);
});

test('app shell: custom Document classes need a hand-written root', () => {
    const project = createProject();
    const documentFile = project.createSourceFile(
        '/project/pages/_document.tsx',
        `import Document, { Html, Head, Main, NextScript } from 'next/document';\nexport default class MyDocument extends Document {\n    static async getInitialProps(ctx) {\n        return Document.getInitialProps(ctx);\n    }\n    render() {\n        return <Html><Head /><body><Main /><NextScript /></body></Html>;\n    }\n}`
    );
    assert.throws(() => buildRootFile(project, fakeContext(), { documentFile, middleware: [] }), /next-to-react-router\.config\.mjs/);
});

test('cli: --help, --version and --hash', () => {
    assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /Usage:/);
    assert.match(spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).stdout, /^\d+\.\d+\.\d+/);
    const file = path.join(tempProject({ 'a.txt': 'hello\r\n' }), 'a.txt');
    assert.equal(sha256(file), sha256(path.join(tempProject({ 'a.txt': 'hello\n' }), 'a.txt')), 'line endings do not change the hash');
    assert.match(spawnSync(process.execPath, [cli, '--hash', file], { encoding: 'utf8' }).stdout, new RegExp(`^${sha256(file)}  `));
});

test('cli: projects that cannot be converted are refused with a reason', () => {
    const notNext = tempProject({ 'package.json': '{ "dependencies": {} }', 'tsconfig.json': '{}', 'pages/index.tsx': '' });
    assert.match(convert(notNext, '--skip-install').stderr, /`next` is not a dependency/);

    const javascript = tempProject({
        'package.json': '{ "dependencies": { "next": "15" } }',
        'tsconfig.json': '{}',
        'pages/index.jsx': '',
    });
    assert.match(convert(javascript, '--skip-install').stderr, /Only TypeScript pages are supported/);

    const unsupportedConfig = tempProject({
        'package.json': '{ "dependencies": { "next": "15" } }',
        'tsconfig.json': '{}',
        'pages/index.tsx': 'export default function Home() {\n    return null;\n}\n',
        'next.config.js': 'module.exports = { basePath: "/docs", async redirects() { return []; } };',
    });
    const refused = convert(unsupportedConfig, '--skip-install');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cannot convert: basePath, redirects/);
    assert.equal(fs.existsSync(path.join(unsupportedConfig, 'pages/index.tsx')), true, 'nothing is changed when refusing');
    assert.equal(
        convert(unsupportedConfig, '--skip-install', '--ignore-config-key', 'basePath', '--ignore-config-key', 'redirects').status,
        0
    );
});

test(
    "cli: Yarn Plug'n'Play is refused before anything changes",
    { skip: !/^[2-9]|^\d{2}/.test(spawnSync('yarn', ['--version'], { encoding: 'utf8' }).stdout ?? '') && 'needs Yarn 2+' },
    () => {
        const dir = tempProject({
            'package.json': '{ "dependencies": { "next": "15" } }',
            'tsconfig.json': '{}',
            'yarn.lock': '',
            '.yarnrc.yml': 'enableGlobalCache: true\n',
            'pages/index.tsx': 'export default function Home() {\n    return null;\n}\n',
        });
        const refused = convert(dir);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /Plug'n'Play is not supported/);
        assert.equal(fs.existsSync(path.join(dir, 'pages/index.tsx')), true);
    }
);

test('cli: a missing package manager is reported before anything changes', () => {
    const dir = tempProject({
        'package.json': '{ "dependencies": { "next": "15" } }',
        'tsconfig.json': '{}',
        'pnpm-lock.yaml': '',
        'pages/index.tsx': 'export default function Home() {\n    return null;\n}\n',
    });
    const result = spawnSync(process.execPath, [cli, '--root', dir], {
        encoding: 'utf8',
        env: { ...process.env, PATH: path.dirname(process.execPath) },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uses pnpm .* failed/);
    assert.equal(fs.existsSync(path.join(dir, 'pages/index.tsx')), true);
});

test('cli: a replaced file that changed stops the run (config "replaces")', () => {
    const dir = tempProject({
        'package.json': '{ "dependencies": { "next": "15" } }',
        'tsconfig.json': '{}',
        'pages/index.tsx': 'export default function Home() {\n    return null;\n}\n',
        'pages/_app.tsx': 'export default function App({ Component, pageProps }) {\n    return <Component {...pageProps} />;\n}\n',
        'conversion/root.tsx': "import { Outlet } from 'react-router';\nexport default function App() {\n    return <Outlet />;\n}\n",
        'next-to-react-router.config.mjs': `export default {\n    files: { 'app/root.tsx': './conversion/root.tsx' },\n    replaces: { 'pages/_app.tsx': { sha256: 'stale', by: 'conversion/root.tsx' } },\n};\n`,
    });
    const refused = convert(dir, '--skip-install');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /pages\/_app\.tsx → conversion\/root\.tsx/);
    const accepted = convert(dir, '--skip-install', '--accept-drift');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'app/root.tsx'), 'utf8'), fs.readFileSync(path.join(dir, 'conversion/root.tsx'), 'utf8'));
});

test('cli: converts the basic fixture', () => {
    const dir = copyFixture('basic');
    const result = convert(dir, '--skip-install');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
    const exists = (file) => fs.existsSync(path.join(dir, file));

    for (const gone of ['pages', 'next.config.js', 'middleware.ts']) assert.equal(exists(gone), false, `${gone} should be gone`);
    assert.match(read('app/root.tsx'), /import Script from '\.\/lib\/script';/);
    assert.match(read('app/root.tsx'), /<Script id="early" strategy="beforeInteractive">/);
    assert.match(read('app/routes/about.tsx'), /import Script from '\.\.\/lib\/script';/);
    for (const file of [
        'app/lib/script.tsx',
        'app/root.tsx',
        'app/routes.ts',
        'app/routes/index.tsx',
        'app/routes/posts/[id].tsx',
        'app/middleware.server.ts',
        'app/fonts.css',
        'app/lib/dynamic.tsx',
        'app/lib/image.tsx',
        'app/lib/image-config.ts',
        'app/lib/trailing-slash.server.ts',
        'app/entry.server.tsx',
        'server.js',
        'vite.config.ts',
        'env.d.ts',
    ]) {
        assert.equal(exists(file), true, `${file} should exist`);
    }
    assert.equal(exists('app/entry.client.tsx'), false, 'reactStrictMode: true keeps the default client entry');

    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.dependencies.next, undefined);
    assert.equal(pkg.scripts.build, 'react-router build');
    for (const name of ['react-router', 'sharp', '@fontsource/inter']) assert.ok(pkg.dependencies[name], `${name} should be a dependency`);

    assert.match(read('app/routes.ts'), /route\('posts\/:id', 'routes\/posts\/\[id\]\.tsx', \{ id: '\/posts\/:id' \}\)/);
    assert.match(read('app/routes.ts'), /route\('\*', 'routes\/404\.tsx'/);
    assert.match(read('app/root.tsx'), /export const middleware = \[trailingSlashRedirect, requestMiddleware\];/);
    assert.match(read('app/root.tsx'), /import NotFoundPage from '\.\/routes\/404';/);
    assert.match(read('app/routes/index.tsx'), /import logoUrl from '\.\.\/\.\.\/assets\/logo\.png';/);
    assert.match(read('app/routes/index.tsx'), /const logo = \{ src: logoUrl, width: 48, height: 24 \};/);
    assert.match(read('app/routes/index.tsx'), /import\.meta\.env\.VITE_SITE_NAME/);
    assert.match(read('app/lib/image-config.ts'), /hostname: 'images\.example\.com'/);
    assert.match(read('.env.example'), /^VITE_SITE_NAME=Fixture$/m);
    assert.match(read('env.d.ts'), /readonly VITE_SITE_NAME\?: string;/);
    assert.equal(JSON.parse(read('tsconfig.json')).compilerOptions.plugins, undefined);

    const all = fs.readdirSync(path.join(dir, 'app'), { recursive: true }).filter((name) => /\.tsx?$/.test(name));
    for (const name of all) assert.doesNotMatch(read(path.join('app', name)), /from 'next[/']/, `${name} still imports from next`);

    // running it again on the result is refused
    assert.match(convert(dir, '--skip-install').stderr, /`next` is not a dependency/);
});

test('cli: converts the src-layout fixture', () => {
    const dir = copyFixture('src-layout');
    const result = convert(dir, '--skip-install');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');

    assert.equal(fs.existsSync(path.join(dir, 'src/pages')), false);
    assert.match(read('react-router.config.ts'), /appDirectory: 'src\/app'/);
    assert.match(read('vite.config.ts'), /find: \/\^@\\\/\/, replacement: `\$\{import\.meta\.dirname\}\/src\/`/);
    assert.match(read('src/app/routes/users/[id].tsx'), /import \{ parseQuery \} from '@\/app\/lib\/navigation';/);
    assert.match(read('src/components/UserCard.tsx'), /routePattern === '\/users\/:id'/);
    assert.equal(fs.existsSync(path.join(dir, 'src/app/lib/trailing-slash.server.ts')), false, 'skipTrailingSlashRedirect is respected');
    assert.equal(fs.existsSync(path.join(dir, 'src/app/entry.client.tsx')), true);
    assert.equal(JSON.parse(read('package.json')).scripts['type-check'], 'react-router typegen && tsc --noEmit');
});
