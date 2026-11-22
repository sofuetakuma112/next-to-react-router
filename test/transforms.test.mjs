import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectResponseFactories, transformDataFunctions } from '../lib/transforms/data-functions.mjs';
import { transformFont } from '../lib/transforms/font.mjs';
import { matcherToRegExpSource, transformMiddleware } from '../lib/transforms/middleware.mjs';
import { addStatusLoader, transformPageStatics, transformPageTypes, wrapPageWithLoaderData } from '../lib/transforms/pages.mjs';
import {
    transformFetchPriorityAttribute,
    transformGlobalJsxNamespace,
    transformOnInputHandlers,
    transformRefCallbackReturns,
    transformRefObjectTypes,
    transformUseRefWithoutArgument,
} from '../lib/transforms/react19.mjs';
import { transformRouter } from '../lib/transforms/router.mjs';
import {
    removeUseClient,
    transformDynamic,
    transformEnv,
    transformHead,
    transformImage,
    transformImageEndpointLiterals,
    transformLink,
    transformRoutePatternLiterals,
    transformScript,
} from '../lib/transforms/simple.mjs';
import { CodemodError } from '../lib/util.mjs';
import { apply, createProject, fakeContext, squash } from './helpers.mjs';

test('env: NEXT_PUBLIC_ variables become import.meta.env.VITE_', () => {
    const report = fakeContext().report;
    const output = apply(`const url = process.env.NEXT_PUBLIC_API_URL || '';\nconst secret = process.env.API_SECRET;`, (file) =>
        transformEnv(file, report)
    );
    assert.equal(output, `const url = import.meta.env.VITE_API_URL || '';\nconst secret = process.env.API_SECRET;`);
    assert.deepEqual([...report.publicEnv], ['VITE_API_URL']);
    assert.deepEqual([...report.serverEnv], ['API_SECRET']);
});

test('env: NODE_ENV comparisons become import.meta.env.DEV / PROD', () => {
    const report = fakeContext().report;
    const output = apply(
        `const a = process.env.NODE_ENV === 'development';\nconst b = process.env.NODE_ENV !== 'production';\nconst c = process.env.NODE_ENV;`,
        (file) => transformEnv(file, report)
    );
    assert.equal(output, `const a = import.meta.env.DEV;\nconst b = !import.meta.env.PROD;\nconst c = import.meta.env.MODE;`);
});

test("'use client' is removed", () => {
    assert.equal(apply(`'use client';\n\nexport const a = 1;\n`, removeUseClient).trim(), 'export const a = 1;');
});

test('link: href becomes to, URL objects become { pathname, search }', () => {
    const output = apply(
        `import Link from 'next/link';\nexport const a = <Link href="/a">A</Link>;\nexport const b = <Link href={{ pathname: '/b', query: { q: 1 } }} scroll={false}>B</Link>;\nexport const c = <Link href={ok ? '/c' : { pathname: '/d', query }}>C</Link>;`,
        (file) => transformLink(file, fakeContext())
    );
    assert.match(output, /import \{ Link \} from 'react-router';/);
    assert.match(output, /import \{ searchOf \} from '@\/app\/lib\/navigation';/);
    assert.match(output, /<Link to="\/a">A<\/Link>/);
    assert.match(output, /<Link to=\{\{ pathname: '\/b', search: searchOf\(\{ q: 1 \}\) \}\} preventScrollReset>B<\/Link>/);
    assert.match(output, /\{ pathname: '\/d', search: searchOf\(query\) \}/);
});

test('link: unsupported props stop the conversion', () => {
    assert.throws(
        () =>
            apply(`import Link from 'next/link';\nexport const a = <Link href="/a" legacyBehavior>A</Link>;`, (file) =>
                transformLink(file, fakeContext())
            ),
        CodemodError
    );
});

test('router: members of useRouter() become React Router hooks', () => {
    const output = apply(
        `import { useRouter } from 'next/router';
export function Example() {
    const router = useRouter();
    const id = router.query.id;
    const active = router.pathname === '/posts/[id]';
    const go = () => router.push({ pathname: '/results', query: { q: id } });
    const swap = () => router.replace('/login');
    return <a href={router.asPath} onClick={() => router.back()}>{String(router.isReady && active)}</a>;
}`,
        (file) => transformRouter(file, fakeContext())
    );
    const text = squash(output);
    assert.match(text, /const query = useQuery\(\);/);
    assert.match(text, /const routePattern = useRoutePattern\(\);/);
    assert.match(text, /const navigate = useNavigate\(\);/);
    assert.match(text, /const location = useLocation\(\);/);
    assert.match(text, /const id = query\.id;/);
    assert.match(text, /navigate\(\{ pathname: '\/results', search: searchOf\(\{ q: id \}\) \}\)/);
    assert.match(text, /navigate\('\/login', \{ replace: true \}\)/);
    assert.match(text, /href=\{createPath\(location\)\}/);
    assert.match(text, /navigate\(-1\)/);
    assert.match(text, /String\(active\)/);
    assert.doesNotMatch(output, /next\/router/);
});

test('router: isReady is always true, and the usual shapes are simplified', () => {
    const output = apply(
        `import { useEffect } from 'react';
import { useRouter } from 'next/router';
export function Example({ keyword }: { keyword?: string }) {
    const router = useRouter();
    useEffect(() => {
        if (!router.isReady) return;
        if (router.isReady && keyword !== undefined) load(keyword);
        else if (router.isReady && keyword === undefined) reset();
    }, [router.isReady, keyword]);
    useEffect(() => {}, [keyword, router.isReady]);
    return <p hidden={!router.isReady}>{String(router.isReady)}</p>;
}`,
        (file) => transformRouter(file, fakeContext())
    );
    const text = squash(output);
    assert.doesNotMatch(text, /isReady|!true|true &&|\[true/);
    assert.match(
        text,
        /useEffect\(\(\) => \{ if \(keyword !== undefined\) load\(keyword\); else if \(keyword === undefined\) reset\(\); \}, \[keyword\]\);/
    );
    assert.match(text, /useEffect\(\(\) => \{\}, \[keyword\]\);/);
    assert.match(text, /<p hidden=\{false\}>\{String\(true\)\}<\/p>/);
});

test('router: `const query = router.query` keeps its name', () => {
    const output = apply(
        `import { useRouter } from 'next/router';\nexport function Example() {\n    const router = useRouter();\n    const query = router.query;\n    return <p>{query.page}</p>;\n}`,
        (file) => transformRouter(file, fakeContext())
    );
    assert.equal(squash(output).includes('const query = useQuery(); return <p>{query.page}</p>;'), true);
});

test('router: destructured useRouter()', () => {
    const output = apply(
        `import { useRouter } from 'next/router';\nexport function Example() {\n    const { query, push, pathname: current } = useRouter();\n    return <button onClick={() => push('/next')}>{current}{query.a}</button>;\n}`,
        (file) => transformRouter(file, fakeContext())
    );
    const text = squash(output);
    assert.match(text, /const navigate = useNavigate\(\); const query = useQuery\(\); const current = useRoutePattern\(\);/);
    assert.match(text, /navigate\('\/next'\)/);
});

test('router: a router prop typed NextRouter is replaced by hooks, withRouter() is unwrapped', () => {
    const output = apply(
        `import { withRouter, NextRouter } from 'next/router';
interface Props {
    router: NextRouter;
    to: string;
}
function Redirect({ router, to }: Props) {
    router.replace(to);
    return null;
}
export default withRouter(Redirect);`,
        (file) => transformRouter(file, fakeContext())
    );
    const text = squash(output);
    assert.match(text, /interface Props \{ to: string; \}/);
    assert.match(text, /function Redirect\(\{ to \}: Props\) \{ const navigate = useNavigate\(\); navigate\(to, \{ replace: true \}\);/);
    assert.match(text, /export default Redirect;/);
});

test('router: unsupported members stop the conversion', () => {
    assert.throws(
        () =>
            apply(
                `import { useRouter } from 'next/router';\nexport function Example() {\n    const router = useRouter();\n    return <p>{router.locale}</p>;\n}`,
                (file) => transformRouter(file, fakeContext())
            ),
        /router\.locale/
    );
});

test('head: <Head> becomes a fragment and stylesheets get a precedence', () => {
    const output = apply(
        `import Head from 'next/head';\nexport const a = (\n    <Head>\n        <title>Hello</title>\n        <link rel="stylesheet" href="/a.css" />\n    </Head>\n);`,
        transformHead
    );
    assert.doesNotMatch(output, /next\/head|<Head>/);
    assert.match(output, /<>\s*<title>Hello<\/title>\s*<link precedence="default" rel="stylesheet" href="\/a.css" \/>\s*<\/>/);
});

test('head: a <title> with several children is rejected (React 19 requires one string)', () => {
    assert.throws(
        () => apply(`import Head from 'next/head';\nexport const a = <Head><title>Hi {name}</title></Head>;`, transformHead),
        CodemodError
    );
});

test('script: next/script points at the generated Script component; strategies are kept', () => {
    const context = fakeContext();
    const output = apply(
        `import Script from 'next/script';\nexport const a = <Script src="https://example.com/a.js" strategy="afterInteractive" />;\nexport const b = <Script id="inline" strategy="beforeInteractive">{\`window.a = 1;\`}</Script>;`,
        (file) => transformScript(file, context)
    );
    assert.match(output, /^import Script from '@\/app\/lib\/script';/);
    assert.match(output, /<Script src="https:\/\/example.com\/a.js" strategy="afterInteractive" \/>/);
    assert.match(output, /<Script id="inline" strategy="beforeInteractive">/);
    assert.deepEqual([...context.report.usedModules], ['script']);
    assert.throws(
        () =>
            apply(`import Script from 'next/script';\nexport const a = <Script src="/a.js" strategy="worker" />;`, (file) =>
                transformScript(file, fakeContext())
            ),
        /worker/
    );
});

test('image and dynamic imports point at the generated helpers', () => {
    const context = fakeContext();
    const output = apply(
        `import Image, { StaticImageData } from 'next/image';\nimport dynamic from 'next/dynamic';\nexport const a: StaticImageData | null = null;\nexport const B = dynamic(() => import('./B'));\nexport const c = <Image src="/a.png" alt="" />;`,
        (file) => {
            transformImage(file, context);
            transformDynamic(file, context);
        }
    );
    assert.match(output, /import Image, \{ StaticImageData \} from '@\/app\/lib\/image';/);
    assert.match(output, /import dynamic from '@\/app\/lib\/dynamic';/);
    assert.deepEqual([...context.report.usedModules].sort(), ['dynamic', 'image']);
});

test('route patterns in strings use React Router syntax; other strings are left alone', () => {
    const output = apply(
        "const a = '/posts/[id]';\nconst b = `${prefix}/[slug]/edit`;\nconst c = '/docs/[...path]';\nconst d = 'mt-[17px] w-[calc(100%/2)]';",
        transformRoutePatternLiterals
    );
    assert.equal(
        output,
        "const a = '/posts/:id';\nconst b = `${prefix}/:slug/edit`;\nconst c = '/docs/*';\nconst d = 'mt-[17px] w-[calc(100%/2)]';"
    );
});

test('/_next/image URLs are rewritten', () => {
    assert.equal(
        apply('const a = `/_next/image?url=${u}&w=640&q=75`;', transformImageEndpointLiterals),
        'const a = `/_image?url=${u}&w=640&q=75`;'
    );
});

function dataFunctions(code, file = '/project/pages/example.tsx') {
    const project = createProject();
    const sourceFile = project.createSourceFile(file, code);
    const result = transformDataFunctions(sourceFile, { responseFactories: collectResponseFactories(project), context: fakeContext() });
    return { text: sourceFile.getFullText(), ...result };
}

test('data: getServerSideProps returning props, a redirect and notFound', () => {
    const { text, loader } = dataFunctions(
        `import type { GetServerSideProps } from 'next';
export const getServerSideProps: GetServerSideProps<{ id: string }> = async ({ params, query }) => {
    if (!params?.id) return { notFound: true };
    if (query.old) return { redirect: { destination: '/new', permanent: true } };
    return { props: { id: String(params.id) } };
};`
    );
    const output = squash(text);
    assert.equal(loader, 'getServerSideProps');
    assert.match(
        output,
        /export const loader = async \(\{ params, url \}: LoaderFunctionArgs\) => \{ const query = parseQuery\(url\.searchParams\);/
    );
    assert.match(output, /throw data\(null, \{ status: 404 \}\);/);
    assert.match(output, /return redirect\('\/new', 308\);/);
    assert.match(output, /return \{ id: String\(params\.id\) \};/);
    assert.doesNotMatch(text, /from 'next'/);
});

test('data: response headers and status move into data() / redirect()', () => {
    const { text } = dataFunctions(
        `import type { GetServerSidePropsContext } from 'next';
function noCache(context: GetServerSidePropsContext) {
    context.res.setHeader('Cache-Control', 'no-cache');
}
export async function getServerSideProps(context: GetServerSidePropsContext) {
    noCache(context);
    context.res.statusCode = 404;
    if (context.query.go) return { redirect: { destination: '/x', statusCode: 301 } };
    return { props: { missing: true } };
}`
    );
    const output = squash(text);
    assert.doesNotMatch(output, /noCache|\.res\b/);
    assert.match(output, /return redirect\('\/x', \{ status: 301, headers: \{ 'Cache-Control': 'no-cache' \} \}\);/);
    assert.match(output, /return data\(\{ missing: true \}, \{ status: 404, headers: \{ 'Cache-Control': 'no-cache' \} \}\);/);
});

test('data: writing the response body by hand becomes a Response', () => {
    const { text } = dataFunctions(
        `import type { GetServerSideProps } from 'next';
export const getServerSideProps: GetServerSideProps = async ({ res }) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end('hello');
    return { props: {} };
};`
    );
    assert.match(
        squash(text),
        /export const loader = async \(\) => \{ return new Response\('hello', \{ headers: \{ 'Content-Type': 'text\/plain' \} \}\); \};/
    );
});

test('data: helpers that write to a ServerResponse return a Response instead', () => {
    const project = createProject();
    const helper = project.createSourceFile(
        '/project/lib/xml.ts',
        `import type { ServerResponse } from 'http';\nexport function writeXml(res: ServerResponse, body: string) {\n    res.setHeader('Content-Type', 'application/xml');\n    res.end(body);\n}`
    );
    const page = project.createSourceFile(
        '/project/pages/feed.tsx',
        `import type { GetServerSidePropsContext } from 'next';\nimport { writeXml } from '../lib/xml';\nexport async function getServerSideProps(context: GetServerSidePropsContext) {\n    writeXml(context.res, '<feed />');\n    return { props: {} };\n}`
    );
    const options = { responseFactories: collectResponseFactories(project), context: fakeContext() };
    transformDataFunctions(helper, options);
    transformDataFunctions(page, options);
    assert.match(
        squash(helper.getFullText()),
        /export function writeXml\(body: string\) : Response \{ return new Response\(body, \{ headers: \{ 'Content-Type': 'application\/xml' \} \}\); \}/
    );
    assert.match(
        squash(page.getFullText()),
        /export async function loader\(_context: LoaderFunctionArgs\) \{ return writeXml\('<feed \/>'\); \}/
    );
});

test('data: a getStaticProps that returns nothing is dropped', () => {
    const { text, loader } = dataFunctions(
        `export async function getStaticProps() {\n    return { props: {} };\n}\nexport default function Page() {\n    return null;\n}`
    );
    assert.equal(loader, null);
    assert.doesNotMatch(text, /getStaticProps|loader/);
});

test('data: reading the query twice goes through a variable', () => {
    const { text } = dataFunctions(
        `import type { GetServerSidePropsContext } from 'next';\nexport async function getServerSideProps(context: GetServerSidePropsContext) {\n    const tab = typeof context.query.tab === 'string' ? context.query.tab : 'a';\n    return { props: { tab } };\n}`
    );
    assert.match(
        squash(text),
        /const query = parseQuery\(context\.url\.searchParams\); const tab = typeof query\.tab === 'string' \? query\.tab : 'a';/
    );
});

test('pages: statics become the route handle; getLayout gets a parameter type', () => {
    const output = apply(
        `function Page() {\n    return null;\n}\nPage.getLayout = (page) => <Layout>{page}</Layout>;\nPage.auth = true;\nPage.displayName = 'Page';\nexport default Page;`,
        transformPageStatics,
        '/project/pages/example.tsx'
    );
    const text = squash(output);
    assert.match(text, /export const handle = \{ getLayout: \(page: ReactElement\) => <Layout>\{page\}<\/Layout>, auth: true, \};/);
    assert.match(text, /Page\.displayName = 'Page';/);
    assert.match(text, /import type \{ ReactElement \} from 'react';/);
});

test('pages: page types become FC', () => {
    const output = apply(
        `import type { NextPage } from 'next';\nimport { NextPageWithLayout } from './_app';\nimport './page.css';\nconst A: NextPageWithLayout<Props, Initial> = () => null;\nconst B: NextPage = () => null;`,
        (file) => transformPageTypes(file, new Set(['NextPage', 'NextPageWithLayout'])),
        '/project/pages/example.tsx'
    );
    assert.match(output, /const A: FC<Props> = /);
    assert.match(output, /const B: FC = /);
    assert.match(output, /import '\.\/page\.css';/, 'side-effect imports must survive');
    assert.doesNotMatch(output, /_app|from 'next'/);
});

test('pages: a page with a loader receives loaderData', () => {
    const output = apply(
        `export async function loader() {\n    return { a: 1 };\n}\nfunction Page({ a }: { a: number }) {\n    return <p>{a}</p>;\n}\nexport default Page;`,
        wrapPageWithLoaderData,
        '/project/pages/posts/[id].tsx'
    );
    const text = squash(output);
    assert.match(text, /import type \{ Route \} from '\.\/\+types\/\[id\]';/);
    assert.match(text, /export function headers\(\{ loaderHeaders \}: Route\.HeadersArgs\) \{ return loaderHeaders; \}/);
    assert.match(
        text,
        /export default function PageRoute\(\{ loaderData \}: Route\.ComponentProps\) \{ return <Page \{\.\.\.loaderData\} \/>; \}/
    );
});

test('pages: 404 / 500 pages answer with their status', () => {
    const output = apply(
        `export default function NotFound() {\n    return null;\n}`,
        (file) => addStatusLoader(file, 404),
        '/project/pages/404.tsx'
    );
    assert.match(squash(output), /export function loader\(\) \{ return data\(null, \{ status: 404 \}\); \}/);
});

test('react 19: type-level changes', () => {
    const output = apply(
        `import { useRef, RefObject } from 'react';
declare const handler: React.ChangeEventHandler<HTMLInputElement>;
export function Example({ target }: { target: RefObject<HTMLDivElement> }): JSX.Element {
    const timer = useRef<number>();
    const items = useRef<HTMLLIElement[]>([]);
    return (
        <ul>
            <li ref={(el) => (items.current[0] = el!)} />
            <input onInput={handler} />
            <img
                // @ts-ignore
                fetchpriority="high"
            />
        </ul>
    );
}`,
        (file) => {
            transformGlobalJsxNamespace(file);
            transformUseRefWithoutArgument(file);
            transformRefObjectTypes(file);
            transformRefCallbackReturns(file);
            transformOnInputHandlers(file);
            transformFetchPriorityAttribute(file);
        }
    );
    const text = squash(output);
    assert.match(text, /type JSX/);
    assert.match(text, /RefObject<HTMLDivElement \| null>/);
    assert.match(text, /useRef<number>\(undefined\)/);
    assert.match(text, /ref=\{\(el\) => \{ items\.current\[0\] = el!; \}\}/);
    assert.match(text, /onInput=\{handler as unknown as InputEventHandler<HTMLInputElement>\}/);
    assert.match(text, /<img fetchPriority="high" \/>/);
    assert.doesNotMatch(text, /@ts-ignore/);
});

test('middleware: matcher syntax', () => {
    assert.equal(matcherToRegExpSource('/about'), '^/about$');
    assert.equal(matcherToRegExpSource('/posts/:path*'), '^/posts(?:/.*)?$');
    assert.equal(matcherToRegExpSource('/users/:id'), '^/users/[^/]+$');
    assert.equal(matcherToRegExpSource('/((?!_next/).*)'), '^/((?!_next/).*)$');
});

test('middleware: NextResponse calls become React Router middleware', () => {
    const output = apply(
        `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ORIGIN } from './lib/origin';
function host(request: NextRequest) {
    return request.nextUrl.host;
}
export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;
    if (pathname === '/old') return NextResponse.redirect(new URL('/new', request.url));
    if (pathname === '/moved') return NextResponse.redirect(\`\${ORIGIN}/x\`, 301);
    return NextResponse.next();
}
export const config = { matcher: ['/old', '/moved'] };`,
        (file) => transformMiddleware(file, fakeContext(), { fromDir: '/project', toFile: '/project/app/middleware.server.ts' }),
        '/project/middleware.ts'
    );
    const text = squash(output);
    assert.match(text, /import \{ ORIGIN \} from '\.\.\/lib\/origin';/);
    assert.match(text, /function host\(request: Request\) \{ return new URL\(request\.url\)\.host; \}/);
    assert.match(text, /const handleMiddleware: MiddlewareFunction<Response> = async \(\{ request, url \}, next\) => \{/);
    assert.match(text, /export const middleware: MiddlewareFunction<Response> = async \(args, next\) => \{/);
    assert.match(text, /const response = await handleMiddleware\(args, async \(\) => \(downstream = await next\(\)\)\);/);
    assert.match(text, /function relativeRedirect\(response: Response, url: URL\): Response/);
    assert.match(text, /if \(!MATCHER\.some\(\(pattern\) => pattern\.test\(url\.pathname\)\)\) return next\(\);/);
    assert.match(text, /const \{ pathname \} = url;/);
    assert.match(text, /return redirect\(String\(new URL\('\/new', request\.url\)\), 307\);/);
    assert.match(text, /return redirect\(`\$\{ORIGIN\}\/x`, 301\);/);
    assert.match(text, /return next\(\);/);
    assert.doesNotMatch(text, /next\/server|export const config/);
});

test('middleware: rewrites are rejected', () => {
    assert.throws(
        () =>
            apply(
                `import { NextResponse } from 'next/server';\nexport function middleware(request) {\n    return NextResponse.rewrite(new URL('/x', request.url));\n}`,
                (file) => transformMiddleware(file, fakeContext(), { fromDir: '/project', toFile: '/project/app/middleware.server.ts' }),
                '/project/middleware.ts'
            ),
        /NextResponse\.rewrite/
    );
});

test('font: next/font/google becomes Fontsource imports and class names', () => {
    let result;
    const output = apply(
        `import { Roboto_Mono, Inter } from 'next/font/google';\nconst mono = Roboto_Mono({ weight: '500', subsets: ['latin'], variable: '--font-mono' });\nconst inter = Inter({ subsets: ['latin'] });\nexport const className = mono.variable + inter.className;`,
        (file) => {
            result = transformFont(file, fakeContext());
        },
        '/project/pages/_app.tsx'
    );
    assert.match(output, /import '@fontsource\/roboto-mono\/latin-500\.css';/);
    assert.match(output, /import '@fontsource-variable\/inter\/index\.css';/);
    assert.match(
        output,
        /const mono = \{ className: 'font-roboto-mono', variable: 'font-roboto-mono-variable', style: \{ fontFamily: "'Roboto Mono'" \} \};/
    );
    assert.match(output, /const inter = \{ className: 'font-inter', style: \{ fontFamily: "'Inter Variable'" \} \};/);
    assert.deepEqual(result.packages, { '@fontsource/roboto-mono': '^5.0.0', '@fontsource-variable/inter': '^5.0.0' });
    assert.equal(
        result.css.some((rule) => rule.includes("--font-mono: 'Roboto Mono';")),
        true
    );
});
