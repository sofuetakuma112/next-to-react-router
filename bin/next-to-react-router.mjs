#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// When run straight from a checkout (not installed through npm), install the codemod's own dependencies first.
const resolvable = ['ts-morph', 'image-size', 'semver'].every((name) => {
    try {
        import.meta.resolve(name);
        return true;
    } catch {
        return false;
    }
});
if (!resolvable && fs.existsSync(path.join(packageDir, 'package-lock.json'))) {
    console.log("Installing the codemod's dependencies…");
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: packageDir, stdio: 'inherit' });
}

const { run } = await import('../lib/main.mjs');
await run(process.argv.slice(2), packageDir);
