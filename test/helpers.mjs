import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, ts } from 'ts-morph';

export const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const cli = path.join(packageDir, 'bin', 'next-to-react-router.mjs');

/** A context good enough for transforms that only ask where the generated helper modules live. */
export function fakeContext(overrides = {}) {
    const context = {
        root: '/project',
        appDir: '/project/app',
        pagesDir: '/project/pages',
        publicDir: '/project/public',
        aliases: [{ prefix: '@/', dir: '/project' }],
        report: { publicEnv: new Set(), serverEnv: new Set(), warnings: [], usedModules: new Set() },
        modulePath: (name) => `/project/app/${name === 'fonts' ? 'fonts.css' : `lib/${name}`}`,
        specifier: (fromFile, target) => `@/${path.relative('/project', target)}`,
        moduleSpecifier(sourceFile, name) {
            context.report.usedModules.add(name);
            return `@/app/lib/${name}`;
        },
        resolveSpecifier: (fromFile, specifier) =>
            specifier.startsWith('@/') ? path.join('/project', specifier.slice(2)) : path.resolve(path.dirname(fromFile), specifier),
        warn: (message) => context.report.warnings.push(message),
        ...overrides,
    };
    return context;
}

export function createProject() {
    return new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX },
        manipulationSettings: { indentationText: '    ', quoteKind: "'" },
    });
}

/** Runs `transform(sourceFile)` on `code` and returns the resulting text. */
export function apply(code, transform, file = '/project/components/example.tsx') {
    const sourceFile = createProject().createSourceFile(file, code);
    transform(sourceFile);
    return sourceFile.getFullText();
}

/** Collapses whitespace so assertions do not depend on formatting. */
export function squash(text) {
    return text.replace(/\s+/g, ' ').trim();
}

/** Copies a fixture project into a fresh temporary directory. */
export function copyFixture(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `next-to-react-router-${name}-`));
    fs.cpSync(path.join(packageDir, 'test', 'fixtures', name), dir, { recursive: true });
    // Like a real checkout, the fixtures commit .env.example but not .env.
    const example = path.join(dir, '.env.example');
    if (fs.existsSync(example) && !fs.existsSync(path.join(dir, '.env'))) fs.copyFileSync(example, path.join(dir, '.env'));
    return dir;
}
