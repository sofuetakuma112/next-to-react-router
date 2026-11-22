// Everything the codemod needs to know about the project being converted.
import fs from 'node:fs';
import path from 'node:path';
import { ts } from 'ts-morph';
import { CodemodError } from './util.mjs';

function readTsconfig(root) {
    const file = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(file)) return null;
    const { config, error } = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
    if (error) throw new CodemodError(`Could not parse tsconfig.json: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
    return config;
}

/** `paths` entries of the form `"prefix/*": ["./dir/*"]` (the only form Vite aliases can express directly). */
function readAliases(root, tsconfig) {
    const options = tsconfig?.compilerOptions ?? {};
    const baseUrl = path.resolve(root, options.baseUrl ?? '.');
    const aliases = [];
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
        const target = Array.isArray(targets) ? targets[0] : null;
        if (!pattern.endsWith('/*') || !target || !target.endsWith('/*')) continue;
        aliases.push({ prefix: pattern.slice(0, -1), dir: path.resolve(baseUrl, target.slice(0, -2)) });
    }
    // Longest directory first, so the most specific alias wins.
    return aliases.sort((a, b) => b.dir.length - a.dir.length);
}

function detectPackageManager(root) {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
    return 'npm';
}

/** Helper modules the codemod generates. Paths are relative to the app directory, without extension. */
const GENERATED_MODULES = {
    navigation: 'lib/navigation',
    link: 'lib/link',
    scrollRestoration: 'lib/scroll-restoration',
    image: 'lib/image',
    imageConfig: 'lib/image-config',
    dynamic: 'lib/dynamic',
    script: 'lib/script',
    fonts: 'fonts.css',
};

export function createContext({ root, packageDir, options, config }) {
    const srcDir = fs.existsSync(path.join(root, 'pages')) ? '' : fs.existsSync(path.join(root, 'src', 'pages')) ? 'src' : null;
    if (srcDir === null) {
        throw new CodemodError('No pages/ (or src/pages/) directory found. Only the Next.js Pages Router is supported.');
    }
    const baseDir = path.join(root, srcDir);
    const tsconfig = readTsconfig(root);
    const aliases = readAliases(root, tsconfig);
    const appDir = path.join(baseDir, 'app');
    const packageDirRelative = path.relative(root, packageDir);
    const packageInsideRoot = packageDirRelative !== '' && !packageDirRelative.startsWith('..') && !path.isAbsolute(packageDirRelative);

    const context = {
        root,
        options,
        config,
        packageDir,
        /** The codemod's own directory relative to the project, when it lives inside the project (else null). */
        packageDirInProject: packageInsideRoot ? packageDirRelative.split(path.sep).join('/') : null,
        srcDir,
        baseDir,
        pagesDir: path.join(baseDir, 'pages'),
        publicDir: path.join(root, 'public'),
        appDir,
        /** App directory relative to the project root, with forward slashes (`app` or `src/app`). */
        appDirRelative: path.relative(root, appDir).split(path.sep).join('/'),
        tsconfig,
        aliases,
        packageManager: detectPackageManager(root),
        report: { publicEnv: new Set(), serverEnv: new Set(), warnings: [], usedModules: new Set() },

        /** Absolute path (without extension) of a generated helper module. */
        modulePath(name) {
            return path.join(appDir, GENERATED_MODULES[name]);
        },

        /**
         * Import specifier for `target` (absolute path, no extension) as written in `fromFile`.
         * Uses a tsconfig path alias when one covers the target, otherwise a relative path.
         */
        specifier(fromFile, target) {
            for (const alias of aliases) {
                if (target === alias.dir || target.startsWith(alias.dir + path.sep)) {
                    return alias.prefix + path.relative(alias.dir, target).split(path.sep).join('/');
                }
            }
            let relative = path.relative(path.dirname(fromFile), target).split(path.sep).join('/');
            if (!relative.startsWith('.')) relative = `./${relative}`;
            return relative;
        },

        /** Import specifier of a generated helper module, as written in `sourceFile`. Records that the module is needed. */
        moduleSpecifier(sourceFile, name) {
            context.report.usedModules.add(name);
            return context.specifier(sourceFile.getFilePath(), context.modulePath(name));
        },

        /** Resolve an import specifier written in `fromFile` to an absolute path (aliases and relative paths only). */
        resolveSpecifier(fromFile, specifier) {
            if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier);
            for (const alias of aliases) {
                if (specifier.startsWith(alias.prefix)) return path.join(alias.dir, specifier.slice(alias.prefix.length));
            }
            return null;
        },

        warn(message) {
            context.report.warnings.push(message);
        },
    };
    return context;
}
