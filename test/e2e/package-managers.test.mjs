// Converts the basic fixture with each package manager (lockfile detection, install, typegen, build), then
// serves it. A package manager that is not installed is skipped locally; CI installs all of them.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { cli, copyFixture } from '../helpers.mjs';

const servers = [];
after(() => servers.forEach((server) => server.kill()));

function version(command) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

/** How to write each package manager's lockfile for the unconverted fixture. */
const LOCKFILES = {
    pnpm: { args: ['install', '--lockfile-only'], file: 'pnpm-lock.yaml' },
    yarn: { args: ['install', '--ignore-scripts', '--non-interactive'], file: 'yarn.lock' },
    bun: { args: ['install', '--lockfile-only'], file: 'bun.lock' },
};

let port = 3160;
for (const [manager, lockfile] of Object.entries(LOCKFILES)) {
    const installed = version(manager);
    test(`basic fixture with ${manager}`, { skip: installed ? false : `${manager} is not installed` }, async () => {
        const dir = copyFixture('basic');
        if (manager === 'yarn' && Number(installed.split('.')[0]) >= 2) {
            fs.writeFileSync(path.join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\nenableGlobalCache: true\n');
            lockfile.args = ['install', '--mode=update-lockfile'];
        }
        const lock = spawnSync(manager, lockfile.args, {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
        });
        assert.equal(lock.status, 0, lock.stderr);
        assert.ok(fs.existsSync(path.join(dir, lockfile.file)), `${lockfile.file} should exist`);
        fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });

        const result = spawnSync(process.execPath, [cli, '--root', dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
        assert.match(result.stdout, new RegExp(`Installing dependencies \\(${manager} install\\)`));
        assert.match(result.stdout, /Type check and build passed/);
        assert.doesNotMatch(fs.readFileSync(path.join(dir, lockfile.file), 'utf8'), /(^|["\s/])next@15/m, 'next is gone from the lockfile');

        port += 1;
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
        const get = (url) => fetch(`http://localhost:${port}${url}`, { redirect: 'manual' });
        assert.match(await (await get('/posts/1')).text(), /<h1>First post<\/h1>/);
        assert.equal((await get('/old-about')).status, 307);
        assert.equal((await get('/nope')).status, 404);
    });
}
