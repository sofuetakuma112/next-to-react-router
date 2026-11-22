// Converts each fixture for real (install, type check, build), starts the server and requests pages.
// Slow and needs the network: run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { cli, copyFixture } from '../helpers.mjs';

const servers = [];
after(() => servers.forEach((server) => server.kill()));

async function convertAndServe(name, port) {
    const dir = copyFixture(name);
    const result = spawnSync(process.execPath, [cli, '--root', dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
    assert.match(result.stdout, /Type check and build passed/);

    const server = spawn(process.execPath, ['server.js'], {
        cwd: dir,
        env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
        server.stdout.on('data', (chunk) => String(chunk).includes('Ready') && resolve());
        server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
        setTimeout(() => reject(new Error('server did not start')), 30_000);
    });
    return (path, init) => fetch(`http://localhost:${port}${path}`, { redirect: 'manual', ...init });
}

test('basic fixture', async () => {
    const get = await convertAndServe('basic', 3151);

    const home = await get('/');
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<body class="fixture-body">/);
    assert.match(html, /<title>Fixture home<\/title>/);
    assert.match(html, /<h1>Fixture<\/h1>/);
    assert.match(html, /<a [^>]*href="\/about"[^>]*>Relative about<\/a>/, 'a relative href resolves against the page');
    assert.match(html, /class="font-inter-variable" data-title="Fixture home"/);
    assert.match(html, /srcSet="\/_image\?url=%2Fhero\.png&amp;w=384&amp;q=75 1x/);
    // next/script: beforeInteractive is in the HTML, afterInteractive is added in the browser after hydration
    assert.match(html, /<head>[\s\S]*<script id="early">window\.__early = true;<\/script>[\s\S]*<\/head>/);

    const post = await get('/posts/1');
    assert.equal(post.status, 200);
    assert.equal(post.headers.get('cache-control'), 'public, max-age=60');
    const postHtml = await post.text();
    assert.match(postHtml, /<h1>First post<\/h1>/);
    // As in Next.js: relative to /posts/[id], even when the link is in the layout
    assert.match(postHtml, /<a [^>]*href="\/posts\/about"[^>]*>Relative about<\/a>/);
    assert.match(postHtml, /<a [^>]*href="\/about"[^>]*>Up to about<\/a>/);
    assert.match(postHtml, /<a [^>]*href="\/posts\/2"[^>]*>Sibling post<\/a>/);

    assert.equal((await get('/posts/0')).headers.get('location'), '/posts/1');
    assert.equal((await get('/posts/0')).status, 307);
    const missing = await get('/posts/99');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Nothing here/);
    const unknown = await get('/nope');
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /Nothing here/);

    assert.equal((await get('/about/')).status, 308, 'trailing slashes redirect');
    assert.equal((await get('/About')).status, 404, 'URLs are matched case-sensitively, as in Next.js');
    assert.equal((await get('/old-about')).status, 307, 'middleware redirect');
    assert.equal((await get('/old-about')).headers.get('location'), '/about', 'same-host redirects are relative, as in Next.js');
    const about = await (await get('/about')).text();
    assert.match(about, /Loading chart…/);
    assert.doesNotMatch(about, /__aboutRuns/, 'afterInteractive scripts are not rendered on the server');

    const sitemap = await get('/sitemap.xml');
    assert.equal(sitemap.headers.get('content-type'), 'application/xml');
    assert.match(await sitemap.text(), /^<\?xml version="1\.0"/);

    const image = await get('/_image?url=%2Fhero.png&w=640&q=75', { headers: { Accept: 'image/webp' } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    const original = await get('/_image?url=%2Fhero.png&w=640&q=75', { headers: { Accept: '*/*' } });
    assert.equal(original.headers.get('content-type'), 'image/png', 'without image/webp in Accept, the original format is kept');
    assert.equal((await get('/_image?url=%2Fhero.png&w=641&q=75')).status, 400, 'only configured widths are served');
    assert.equal((await get('/_image?url=https%3A%2F%2Fevil.example%2Fa.png&w=640&q=75')).status, 400, 'only configured hosts are fetched');
});

test('src-layout fixture', async () => {
    const get = await convertAndServe('src-layout', 3152);
    assert.match(await (await get('/')).text(), /<h1>Users<\/h1>/);
    const user = await (await get('/users/7?tab=posts')).text();
    assert.match(user, /data-active="true"/);
    assert.match(user, /data-testid="tab">posts</);
    assert.equal((await get('/nope')).status, 404);
});
