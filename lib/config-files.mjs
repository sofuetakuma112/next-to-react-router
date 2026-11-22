// Rewrites the project's configuration files: package.json, tsconfig.json, ESLint, ignore files, env files,
// and generates the Vite / React Router configuration.
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { CodemodError } from './util.mjs';

/** Versions this codemod is tested with. */
const DEPENDENCIES = {
    '@react-router/express': '^8.5.2',
    '@react-router/node': '^8.5.2',
    compression: '^1.8.2',
    express: '^5.3.0',
    isbot: '^5.2.3',
    react: '^19.2.7',
    'react-dom': '^19.2.7',
    'react-router': '^8.5.2',
};
const DEV_DEPENDENCIES = {
    '@react-router/dev': '^8.5.2',
    '@types/node': '^22.19.0',
    '@types/react': '^19.2.0',
    '@types/react-dom': '^19.2.0',
    esbuild: '^0.28.2',
    typescript: '^5.9.3',
    vite: '^8.3.8',
};
/** Added when the image optimizer is generated. */
const IMAGE_DEPENDENCIES = { sharp: '^0.35.5' };
/** Replace `eslint-config-next` when the ESLint config extended it. */
const ESLINT_DEV_DEPENDENCIES = {
    '@typescript-eslint/parser': '^8.73.0',
    'eslint-plugin-import': '^2.31.0',
    'eslint-plugin-jsx-a11y': '^6.10.2',
    'eslint-plugin-react': '^7.37.5',
    'eslint-plugin-react-hooks': '^5.2.0',
};
export const REMOVED_PACKAGES = ['next', 'eslint-config-next', '@next/bundle-analyzer', '@next/eslint-plugin-next', '@next/font'];
const REACT_VERSION = '19.2.7';
const MIN_SASS = '1.70.0';

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function detectIndent(file) {
    const match = /^([ \t]+)"/m.exec(fs.readFileSync(file, 'utf8'));
    return match ? match[1] : '    ';
}

function writeJson(file, value, indent) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, indent)}\n`);
}

function sortKeys(object) {
    return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function updateLines(file, transform) {
    if (!fs.existsSync(file)) return false;
    const source = fs.readFileSync(file, 'utf8');
    const output = transform(source);
    if (output !== source) fs.writeFileSync(file, output);
    return output !== source;
}

/** package.json of an installed (or locked) dependency: `{ version, peerDependencies }`. */
function dependencyManifest(root, name) {
    const installed = path.join(root, 'node_modules', name, 'package.json');
    if (fs.existsSync(installed)) return readJson(installed);
    const lockFile = path.join(root, 'package-lock.json');
    if (fs.existsSync(lockFile)) return readJson(lockFile).packages?.[`node_modules/${name}`] ?? null;
    return null;
}

function usesNextEslintConfig(root) {
    const file = path.join(root, '.eslintrc.json');
    return fs.existsSync(file) && [readJson(file).extends ?? []].flat().some((name) => /^next(\/|$)/.test(name));
}

/**
 * @param extraDependencies dependencies the transforms found a need for (font packages, …)
 * @param features `{ image: boolean }` — optional generated features that bring their own dependencies
 */
export function updatePackageJson(context, { extraDependencies = {}, features = {} } = {}) {
    const { root, config, packageManager } = context;
    const file = path.join(root, 'package.json');
    const indent = detectIndent(file);
    const pkg = readJson(file);

    const dependencies = { ...pkg.dependencies };
    const devDependencies = { ...pkg.devDependencies };
    const set = (target, other, entries) => {
        for (const [name, version] of Object.entries(entries)) {
            delete other[name];
            target[name] = version;
        }
    };
    for (const name of [...REMOVED_PACKAGES, ...(config.value.packages?.remove ?? [])]) {
        delete dependencies[name];
        delete devDependencies[name];
    }
    set(dependencies, devDependencies, { ...DEPENDENCIES, ...(features.image ? IMAGE_DEPENDENCIES : {}), ...extraDependencies });
    set(devDependencies, dependencies, DEV_DEPENDENCIES);

    // Vite needs a recent Sass. Keep the locked version when it is new enough.
    if (dependencies.sass || devDependencies.sass) {
        const locked = dependencyManifest(root, 'sass')?.version;
        set(devDependencies, dependencies, { sass: locked && semver.gte(locked, MIN_SASS) ? `^${locked}` : `^${MIN_SASS}` });
    }
    if (usesNextEslintConfig(root)) {
        set(devDependencies, dependencies, ESLINT_DEV_DEPENDENCIES);
        // @typescript-eslint/parser 8 needs ESLint 8.57+.
        const eslintRange = dependencies.eslint ?? devDependencies.eslint;
        const eslintMin = eslintRange && semver.minVersion(eslintRange);
        if (eslintMin && semver.lt(eslintMin, '8.57.0')) set(devDependencies, dependencies, { eslint: '^8.57.1' });
    }
    set(dependencies, devDependencies, config.value.packages?.dependencies ?? {});
    set(devDependencies, dependencies, config.value.packages?.devDependencies ?? {});

    // npm refuses to install when a library's peer range does not include React 19. For libraries that have not
    // widened their range, tell npm to resolve their React peer to ours. (pnpm and Yarn only warn.)
    const overrides = { ...pkg.overrides };
    if (packageManager === 'npm') {
        for (const name of Object.keys(dependencies)) {
            const peers = dependencyManifest(root, name)?.peerDependencies ?? {};
            const override = {};
            for (const peer of ['react', 'react-dom']) {
                if (peers[peer] && !semver.satisfies(REACT_VERSION, peers[peer])) override[peer] = `$${peer}`;
            }
            if (Object.keys(override).length > 0) overrides[name] = { ...overrides[name], ...override };
        }
    }

    const scripts = { ...pkg.scripts };
    for (const [name, command] of Object.entries(scripts)) {
        if (/^next dev\b/.test(command)) scripts[name] = 'react-router dev';
        else if (/^next build\b/.test(command)) scripts[name] = 'react-router build';
        else if (/^next start\b/.test(command)) scripts[name] = 'NODE_ENV=production node server.js';
        else if (/^next lint\b/.test(command)) scripts[name] = `eslint . --ext .ts,.tsx${/--fix/.test(command) ? ' --fix' : ''}`;
        // Type checking needs the route types generated first.
        else if (/\btsc\b/.test(command) && !/react-router typegen/.test(command)) scripts[name] = `react-router typegen && ${command}`;
    }
    scripts.dev ??= 'react-router dev';
    scripts.build ??= 'react-router build';
    scripts.start ??= 'NODE_ENV=production node server.js';
    scripts.typecheck ??= 'react-router typegen && tsc --noEmit';

    const next = {};
    for (const [key, value] of Object.entries(pkg)) {
        if (['scripts', 'overrides', 'type', 'devDependencies'].includes(key)) continue;
        next[key] = key === 'dependencies' ? sortKeys(dependencies) : value;
        if (key === 'private' || (key === 'version' && !('private' in pkg))) {
            next.type = 'module';
            next.scripts = scripts;
        }
    }
    next.type ??= 'module';
    next.scripts ??= scripts;
    next.dependencies ??= sortKeys(dependencies);
    next.devDependencies = sortKeys(devDependencies);
    if (Object.keys(overrides).length > 0) next.overrides = overrides;
    writeJson(file, next, indent);
}

export function updateTsconfig(context) {
    const { root, packageDirInProject } = context;
    const file = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(file)) throw new CodemodError('tsconfig.json not found (only TypeScript projects are supported)');
    const indent = detectIndent(file);
    const tsconfig = context.tsconfig;
    const options = { ...tsconfig.compilerOptions };
    delete options.incremental;
    if (Array.isArray(options.plugins)) {
        options.plugins = options.plugins.filter((plugin) => plugin?.name !== 'next');
        if (options.plugins.length === 0) delete options.plugins;
    }
    Object.assign(options, {
        target: 'ES2022',
        lib: ['DOM', 'DOM.Iterable', 'ES2022'],
        types: [...new Set([...(options.types ?? []), 'node', 'vite/client'])],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        // vite.config.ts imports `./vite-plugin-route-css-order.ts` with its extension
        allowImportingTsExtensions: true,
        noEmit: true,
        // resolves `./+types/…`, the per-route types written by `react-router typegen`
        rootDirs: ['.', './.react-router/types'],
    });
    const include = (tsconfig.include ?? ['**/*.ts', '**/*.tsx']).filter((entry) => !/next-env\.d\.ts|\.next\//.test(entry));
    const exclude = [...(tsconfig.exclude ?? []), 'node_modules', 'build'];
    if (packageDirInProject) exclude.push(packageDirInProject);
    writeJson(
        file,
        {
            ...tsconfig,
            compilerOptions: options,
            include: [...new Set([...include, '.react-router/types/**/*'])],
            exclude: [...new Set(exclude)],
        },
        indent
    );
}

/** `.eslintrc.json` extending `next` / `next/core-web-vitals` → the same rules without eslint-config-next. */
export function updateEslintConfig(context) {
    const { root, packageDirInProject } = context;
    const other = [
        '.eslintrc.js',
        '.eslintrc.cjs',
        '.eslintrc.yml',
        '.eslintrc.yaml',
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.ts',
    ]
        .filter((name) => fs.existsSync(path.join(root, name)))
        .filter((name) => /\bnext\b/.test(fs.readFileSync(path.join(root, name), 'utf8')));
    if (other.length > 0) context.warn(`${other.join(', ')} refers to the Next.js ESLint config; update it by hand.`);

    const file = path.join(root, '.eslintrc.json');
    if (!usesNextEslintConfig(root)) return;
    const indent = detectIndent(file);
    const config = readJson(file);
    const rules = Object.fromEntries(Object.entries(config.rules ?? {}).filter(([name]) => !name.startsWith('@next/')));
    const ignorePatterns = [...[config.ignorePatterns ?? []].flat().filter((name) => name !== '.next'), 'build', '.react-router'];
    if (packageDirInProject) ignorePatterns.push(packageDirInProject);
    writeJson(
        file,
        {
            ...config,
            root: true,
            parser: '@typescript-eslint/parser',
            parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, ...config.parserOptions },
            env: { browser: true, node: true, es2022: true, ...config.env },
            settings: { ...config.settings, react: { version: 'detect', ...config.settings?.react } },
            plugins: [...new Set([...(config.plugins ?? []), 'import', 'jsx-a11y'])],
            extends: [
                'plugin:react/recommended',
                'plugin:react-hooks/recommended',
                ...[config.extends ?? []].flat().filter((name) => !/^next(\/|$)/.test(name)),
            ],
            rules: {
                // what eslint-config-next (next/core-web-vitals) configured
                'import/no-anonymous-default-export': 'warn',
                'react/no-unknown-property': 'off',
                'react/react-in-jsx-scope': 'off',
                'react/prop-types': 'off',
                'react/jsx-no-target-blank': 'off',
                'jsx-a11y/alt-text': ['warn', { elements: ['img'], img: ['Image'] }],
                'jsx-a11y/aria-props': 'warn',
                'jsx-a11y/aria-proptypes': 'warn',
                'jsx-a11y/aria-unsupported-elements': 'warn',
                'jsx-a11y/role-has-required-aria-props': 'warn',
                'jsx-a11y/role-supports-aria-props': 'warn',
                ...rules,
            },
            ignorePatterns: [...new Set(ignorePatterns)],
        },
        indent
    );
}

export function updateIgnoreFiles(context) {
    const { root, packageDirInProject } = context;
    updateLines(path.join(root, '.gitignore'), (source) => {
        const lines = source.split('\n').filter((line) => !/^\/?(\.next|out)\/?$/.test(line.trim()) && line.trim() !== 'next-env.d.ts');
        const has = (entry) => lines.some((line) => line.trim().replace(/^\//, '').replace(/\/$/, '') === entry);
        const added = ['.react-router', 'build', '.cache'].filter((entry) => !has(entry)).map((entry) => `/${entry}/`);
        const index = lines.findIndex((line) => /^#\s*next\.js\s*$/i.test(line.trim()));
        if (index !== -1) lines.splice(index, 1, '# react router', ...added);
        else if (added.length > 0) lines.push('', '# react router', ...added);
        return `${lines
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/\n+$/, '')}\n`;
    });
    updateLines(path.join(root, '.prettierignore'), (source) => {
        const lines = source.split('\n').filter((line) => !['next-env.d.ts', 'next.config.js', 'next.config.mjs'].includes(line.trim()));
        const replaced = lines.map((line) => (line.trim() === '.next' ? '.react-router' : line));
        if (packageDirInProject && !replaced.some((line) => line.trim() === packageDirInProject)) {
            while (replaced.length > 0 && replaced[replaced.length - 1].trim() === '') replaced.pop();
            replaced.push(packageDirInProject, '');
        }
        return replaced.join('\n');
    });
}

/** Tailwind scans `pages/` for class names; the pages now live in the app directory. */
export function updateTailwindConfig(context) {
    const pages = `./${context.srcDir ? `${context.srcDir}/` : ''}pages/`;
    const app = `./${context.appDirRelative}/`;
    for (const name of ['tailwind.config.mjs', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.ts']) {
        updateLines(path.join(context.root, name), (source) =>
            source.split(`'${pages}`).join(`'${app}`).split(`"${pages}`).join(`"${app}`)
        );
    }
}

/**
 * package.json becomes `"type": "module"`, so `.js` files in the project root written as CommonJS
 * (tool configs such as `.lintstagedrc.js` or `postcss.config.js`) are renamed to `.cjs`.
 */
export function renameCommonJsConfigs(context) {
    const { root } = context;
    const renamed = [];
    for (const name of fs.readdirSync(root)) {
        const file = path.join(root, name);
        if (!name.endsWith('.js') || /^next\.config\./.test(name) || !fs.statSync(file).isFile()) continue;
        const source = fs.readFileSync(file, 'utf8');
        if (!/\bmodule\.exports\b|\brequire\s*\(/.test(source) || /^\s*(import|export)\s/m.test(source)) continue;
        const target = `${name.slice(0, -3)}.cjs`;
        // lint-staged commonly runs a bare `tsc`; route types have to be generated first
        fs.writeFileSync(
            path.join(root, target),
            /lint-?staged/.test(name) ? source.replace(/npx tsc --noEmit/g, 'npm run typecheck') : source
        );
        fs.rmSync(file);
        renamed.push([name, target]);
    }
    updateLines(path.join(root, '.prettierignore'), (source) =>
        renamed.reduce((text, [from, to]) => text.replace(new RegExp(`^${from.replace(/\./g, '\\.')}$`, 'm'), to), source)
    );
    return renamed;
}

/** NEXT_PUBLIC_* → VITE_* in `.env`, `.env.example`, `.env.local`, … */
export function updateEnvFiles(context) {
    const { root } = context;
    const changed = [];
    for (const name of fs.readdirSync(root)) {
        if (!/^\.env(\..+)?$/.test(name) || !fs.statSync(path.join(root, name)).isFile()) continue;
        if (updateLines(path.join(root, name), (source) => source.replace(/^(\s*(?:export\s+)?)NEXT_PUBLIC_/gm, '$1VITE_')))
            changed.push(name);
    }
    return changed;
}

/** env.d.ts: types for the variables Vite inlines into the client bundle. */
export function writeEnvTypes(context) {
    const { root, report } = context;
    const declared = new Set(report.publicEnv);
    for (const name of fs.readdirSync(root)) {
        if (!/^\.env\.(example|sample|template)$/.test(name)) continue;
        for (const match of fs.readFileSync(path.join(root, name), 'utf8').matchAll(/^\s*(VITE_[A-Z0-9_]+)=/gm)) declared.add(match[1]);
    }
    const lines = [
        '/// <reference types="vite/client" />',
        '',
        '// Variables inlined at build time (VITE_* in .env). They end up in the browser bundle: no secrets here.',
        'interface ImportMetaEnv {',
        ...[...declared].sort().map((name) => `    readonly ${name}?: string;`),
        '}',
        '',
        'interface ImportMeta {',
        '    readonly env: ImportMetaEnv;',
        '}',
        '',
    ];
    fs.writeFileSync(path.join(root, 'env.d.ts'), lines.join('\n'));
}

export const NEXT_CONFIG_NAMES = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'];
/** next.config options with no automatic equivalent. The codemod stops unless told to ignore them. */
const UNSUPPORTED_CONFIG_KEYS = [
    'redirects',
    'rewrites',
    'headers',
    'basePath',
    'i18n',
    'assetPrefix',
    'pageExtensions',
    'trailingSlash',
    'distDir',
    'env',
];
const NEXT_CONFIG_KEYS = new Set([
    ...UNSUPPORTED_CONFIG_KEYS,
    ...['images', 'reactStrictMode', 'webpack', 'compress', 'experimental', 'poweredByHeader', 'output', 'skipTrailingSlashRedirect'],
]);

/**
 * Reads next.config without executing it (executing would need the project's Next.js plugins): finds the
 * config object literal and evaluates the literal-valued options the codemod uses.
 */
export function readNextConfig(context) {
    const file = NEXT_CONFIG_NAMES.map((name) => path.join(context.root, name)).find((candidate) => fs.existsSync(candidate));
    const result = { file, keys: [], images: {}, reactStrictMode: false, skipTrailingSlashRedirect: false, trailingSlash: false };
    if (!file) return result;
    const sourceFile = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } }).createSourceFile(
        'next.config.ts',
        fs.readFileSync(file, 'utf8')
    );
    const names = (literal) =>
        literal
            .getProperties()
            .map((property) => (Node.isSpreadAssignment(property) ? null : property.getName()))
            .filter(Boolean);
    // the config object: the object literal with the most Next.js option names
    const [config] = sourceFile
        .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
        .map((literal) => ({ literal, score: names(literal).filter((name) => NEXT_CONFIG_KEYS.has(name)).length }))
        .sort((a, b) => b.score - a.score);
    if (!config || config.score === 0) return result;
    result.keys = names(config.literal);
    for (const key of ['images', 'reactStrictMode', 'skipTrailingSlashRedirect', 'trailingSlash']) {
        const property = config.literal.getProperty(key);
        if (!property || !Node.isPropertyAssignment(property)) continue;
        try {
            result[key] = new Function(`return (${property.getInitializerOrThrow().getText()});`)();
        } catch {
            context.warn(`next.config: could not read "${key}" (not a literal); using the Next.js default.`);
        }
    }
    return result;
}

export function checkNextConfig(context, nextConfig) {
    const ignored = new Set(context.options.ignoreConfigKeys);
    const unsupported = nextConfig.keys.filter(
        (key) => UNSUPPORTED_CONFIG_KEYS.includes(key) && !ignored.has(key) && !(key === 'trailingSlash' && !nextConfig.trailingSlash)
    );
    if (unsupported.length > 0) {
        throw new CodemodError(
            [
                `${path.basename(nextConfig.file)} uses options this codemod cannot convert: ${unsupported.join(', ')}`,
                'Reimplement them after the conversion (redirects / rewrites / headers → a server middleware in app/root.tsx),',
                `then rerun with ${unsupported.map((key) => `--ignore-config-key ${key}`).join(' ')}`,
            ].join('\n')
        );
    }
    if (nextConfig.keys.includes('webpack')) context.warn('next.config: the custom webpack() configuration is not carried over to Vite.');
    if (nextConfig.keys.includes('experimental')) context.warn('next.config: "experimental" options are not carried over.');
}

const DEFAULT_IMAGES = {
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    qualities: [75],
    formats: ['image/webp'],
    minimumCacheTTL: 14400,
    remotePatterns: [],
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
};

/** app/lib/image-config.ts, carrying over `images` from next.config. */
export function writeImageConfig(context, nextConfig) {
    const images = nextConfig.images ?? {};
    const config = {};
    for (const [key, fallback] of Object.entries(DEFAULT_IMAGES)) config[key] = images[key] ?? fallback;
    const patterns = [
        ...(images.domains ?? []).map((hostname) => ({ hostname })),
        ...config.remotePatterns.map(({ protocol, hostname, port, pathname }) => ({ protocol, hostname, port, pathname })),
    ].map((pattern) => Object.fromEntries(Object.entries(pattern).filter(([, value]) => value !== undefined && value !== '')));

    const literal = (value) => JSON.stringify(value).replace(/"/g, "'").replace(/,/g, ', ');
    const patternsText = JSON.stringify(patterns, null, 4)
        .replace(/"(\w+)":/g, '$1:')
        .replace(/"/g, "'")
        .replace(/\n/g, '\n    ');
    const source = `// Settings for image optimization (the /_image route and the Image component).

export interface RemotePattern {
    protocol?: 'http' | 'https';
    hostname: string;
    port?: string;
    pathname?: string;
}

export const IMAGE_CONFIG = {
    /** Candidate widths for images that scale with the viewport (those with \`sizes\`). */
    deviceSizes: ${literal(config.deviceSizes)},
    /** Candidate widths for images with a fixed width. */
    imageSizes: ${literal(config.imageSizes)},
    /** Accepted qualities (the \`q\` parameter). The first one is the default. */
    qualities: ${literal(config.qualities)},
    /** Output formats. When the browser accepts several equally, the first one listed here wins. */
    formats: ${literal(config.formats)},
    /** Minimum time, in seconds, an optimized image is cached. */
    minimumCacheTTL: ${config.minimumCacheTTL},
    /** External images that may be optimized. */
    remotePatterns: ${patternsText} as RemotePattern[],
    contentDispositionType: ${literal(config.contentDispositionType)},
    contentSecurityPolicy: ${JSON.stringify(config.contentSecurityPolicy)},
};
`;
    const file = `${context.modulePath('imageConfig')}.ts`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
}

/** Fills the placeholders of the generated vite.config.ts and react-router.config.ts. */
export function fillBuildConfigs(context, clientDependencies) {
    const { root, aliases, appDirRelative } = context;
    updateLines(path.join(root, 'vite.config.ts'), (source) => {
        const aliasEntries = aliases.map(({ prefix, dir }) => {
            const relative = path.relative(root, dir).split(path.sep).join('/');
            const find = `/^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`;
            return `{ find: ${find}, replacement: \`\${import.meta.dirname}/${relative ? `${relative}/` : ''}\` }`;
        });
        const list = (items, indent) => (items.length > 0 ? `\n${items.map((item) => `${indent}    ${item},`).join('\n')}\n${indent}` : '');
        return source.replace('/*__ALIASES__*/', list(aliasEntries, '        ')).replace(
            '/*__OPTIMIZE_DEPS__*/',
            list(
                clientDependencies.map((name) => `'${name}'`),
                '        '
            )
        );
    });
    updateLines(path.join(root, 'react-router.config.ts'), (source) =>
        source.replace(/^\s*\/\*__APP_DIRECTORY__\*\/\n/m, appDirRelative === 'app' ? '' : `    appDirectory: '${appDirRelative}',\n`)
    );
}
