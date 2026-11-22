import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Project, ts } from 'ts-morph';
import {
    NEXT_CONFIG_NAMES,
    REMOVED_PACKAGES,
    checkNextConfig,
    fillBuildConfigs,
    readNextConfig,
    renameCommonJsConfigs,
    updateEnvFiles,
    updateEslintConfig,
    updateIgnoreFiles,
    updatePackageJson,
    updateTailwindConfig,
    updateTsconfig,
    writeEnvTypes,
    writeImageConfig,
} from './config-files.mjs';
import { applyTextReplacements, checkReplacedFiles, copyProvidedFiles, loadConfig, providedFiles, sha256 } from './config.mjs';
import { createContext } from './context.mjs';
import { listFiles, rewriteImportsAfterMove } from './move.mjs';
import { collectPageRoutes, renderRoutesFile } from './routes.mjs';
import { buildRootFile, collectPageTypeNames } from './transforms/app-shell.mjs';
import { collectResponseFactories, transformDataFunctions } from './transforms/data-functions.mjs';
import { transformFont } from './transforms/font.mjs';
import { transformMiddleware } from './transforms/middleware.mjs';
import { addStatusLoader, transformPageStatics, transformPageTypes, wrapPageWithLoaderData } from './transforms/pages.mjs';
import {
    transformFetchPriorityAttribute,
    transformGlobalJsxNamespace,
    transformOnInputHandlers,
    transformRefCallbackReturns,
    transformRefObjectTypes,
    transformUseRefWithoutArgument,
} from './transforms/react19.mjs';
import { transformRouter } from './transforms/router.mjs';
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
    transformStaticImageImports,
} from './transforms/simple.mjs';
import { CodemodError, isIdentifierUsed, log } from './util.mjs';

const HELP = `Convert a Next.js (Pages Router) app to React Router (framework mode) + Vite.

Usage:
  next-to-react-router [options]

Options:
  --root <dir>               project to convert (default: current directory)
  --config <file>            project config (default: next-to-react-router.config.mjs in the project root)
  --skip-install             do not install dependencies (also skips type generation, formatting and verification)
  --skip-verify              do not type-check and build after converting
  --allow-dirty              run even with uncommitted changes
  --accept-drift             run even if files replaced by hand (config "replaces") have changed
  --ignore-config-key <key>  proceed although next.config uses <key>, which is not converted (repeatable)
  --hash <file...>           print the content hash of files (for the "replaces" option) and exit
  -h, --help                 show this help
  -v, --version              show the version
`;

function parseArgs(argv, packageDir) {
    const options = {
        root: process.cwd(),
        config: null,
        skipInstall: false,
        skipVerify: false,
        allowDirty: false,
        acceptDrift: false,
        ignoreConfigKeys: [],
    };
    const value = (index, flag) => {
        if (argv[index] === undefined) throw new CodemodError(`${flag} needs a value`);
        return argv[index];
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            console.log(HELP);
            process.exit(0);
        } else if (arg === '--version' || arg === '-v') {
            console.log(JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version);
            process.exit(0);
        } else if (arg === '--hash') {
            for (const file of argv.slice(i + 1)) console.log(`${sha256(file)}  ${file}`);
            process.exit(0);
        } else if (arg === '--root') options.root = path.resolve(value(++i, arg));
        else if (arg === '--config') options.config = value(++i, arg);
        else if (arg === '--ignore-config-key') options.ignoreConfigKeys.push(value(++i, arg));
        else if (arg === '--skip-install') options.skipInstall = true;
        else if (arg === '--skip-verify') options.skipVerify = true;
        else if (arg === '--allow-dirty') options.allowDirty = true;
        else if (arg === '--accept-drift') options.acceptDrift = true;
        else throw new CodemodError(`Unknown option: ${arg}\n\n${HELP}`);
    }
    return options;
}

function preflight(context) {
    const { root, options, pagesDir, appDir } = context;
    if (fs.existsSync(appDir)) {
        throw new CodemodError(
            `${context.appDirRelative}/ already exists. The App Router is not supported, and the converted app needs that directory.`
        );
    }
    if (!context.tsconfig) throw new CodemodError('tsconfig.json not found. Only TypeScript projects are supported.');
    const scripts = listFiles(pagesDir, (file) => /\.(jsx?|mdx)$/.test(file));
    if (scripts.length > 0) {
        throw new CodemodError(
            `Only TypeScript pages are supported. Found:\n${scripts.map((file) => `  - ${path.relative(root, file)}`).join('\n')}`
        );
    }
    if (fs.existsSync(path.join(pagesDir, 'api'))) throw new CodemodError('API Routes (pages/api) are not supported.');
    // JavaScript files are not transformed; one that uses Next.js would be left behind unconverted.
    const skip = context.packageDirInProject ? [path.join(root, context.packageDirInProject)] : [];
    const untransformed = listFiles(
        root,
        (file) => /\.(jsx?|mjs|cjs)$/.test(file) && !/(^|[\\/])next\.config\.[cm]?js$/.test(file),
        skip
    ).filter((file) => /from\s+['"]next(\/[^'"]*)?['"]|require\(\s*['"]next(\/[^'"]*)?['"]\s*\)/.test(fs.readFileSync(file, 'utf8')));
    if (untransformed.length > 0) {
        throw new CodemodError(
            `These JavaScript files import from Next.js. Only TypeScript sources are converted:\n${untransformed.map((file) => `  - ${path.relative(root, file)}`).join('\n')}`
        );
    }

    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 22)) {
        throw new CodemodError(`Node.js 22.22 or newer is required (React Router 8); this is ${process.version}.`);
    }

    if (!options.allowDirty && fs.existsSync(path.join(root, '.git'))) {
        const pathspec = ['.', ...(context.packageDirInProject ? [`:(exclude)${context.packageDirInProject}`] : [])];
        const status = execFileSync('git', ['status', '--porcelain', '--', ...pathspec], { cwd: root, encoding: 'utf8' });
        if (status.trim()) {
            throw new CodemodError(`There are uncommitted changes. Commit or stash them first (or pass --allow-dirty).\n${status}`);
        }
    }
    checkReplacedFiles(context);

    // Fail before touching anything when the package manager the project uses is not installed.
    if (!options.skipInstall) {
        const probe = spawnSync(context.packageManager, ['--version'], { cwd: root, encoding: 'utf8' });
        if (probe.status !== 0) {
            throw new CodemodError(
                `This project uses ${context.packageManager} (found its lockfile), but \`${context.packageManager} --version\` failed. Install it, or pass --skip-install.`
            );
        }
        // Yarn 2+ installs with Plug'n'Play unless told otherwise. There is no node_modules then, and the
        // verification steps (and React Router's server build) need one.
        if (context.packageManager === 'yarn' && Number(probe.stdout.trim().split('.')[0]) >= 2) {
            const yarnrc = path.join(root, '.yarnrc.yml');
            const linker = fs.existsSync(yarnrc)
                ? /^\s*nodeLinker:\s*["']?([\w-]+)/m.exec(fs.readFileSync(yarnrc, 'utf8'))?.[1]
                : undefined;
            if (linker !== 'node-modules' && linker !== 'pnpm') {
                throw new CodemodError(
                    "Yarn Plug'n'Play is not supported. Add `nodeLinker: node-modules` to .yarnrc.yml, run `yarn install`, commit, and run again."
                );
            }
        }
    }
}

function loadProject(context) {
    const project = new Project({
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, allowJs: false },
        manipulationSettings: { indentationText: '    ', quoteKind: "'", useTrailingCommas: false },
    });
    const skip = context.packageDirInProject ? [path.join(context.root, context.packageDirInProject)] : [];
    for (const file of listFiles(context.root, (candidate) => /\.tsx?$/.test(candidate), skip)) project.addSourceFileAtPath(file);
    return project;
}

function runCommand(command, args, cwd, env = process.env) {
    return spawnSync(command, args, { cwd, stdio: 'inherit', env }).status === 0;
}

/**
 * How to install with each package manager. The codemod has just changed package.json, so the lockfile has to be
 * updated; in CI (CI=true) pnpm and Yarn 2+ refuse to do that unless told to.
 */
const INSTALL = {
    npm: { args: ['install', '--no-audit', '--no-fund'], env: {} },
    pnpm: { args: ['install', '--no-frozen-lockfile'], env: {} },
    yarn: { args: ['install'], env: { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' } },
    bun: { args: ['install'], env: {} },
};

/** `npx <bin>` for the project's package manager. */
function execArgs(packageManager, args) {
    if (packageManager === 'pnpm') return ['pnpm', ['exec', ...args]];
    if (packageManager === 'yarn') return ['yarn', args];
    if (packageManager === 'bun') return ['bunx', args];
    return ['npx', args];
}

function sideEffectImports(sourceFile) {
    return sourceFile
        .getImportDeclarations()
        .filter((decl) => !decl.getImportClause())
        .map((decl) => decl.getModuleSpecifierValue());
}

function importedNames(sourceFile) {
    return sourceFile.getImportDeclarations().flatMap((decl) => {
        const names = decl.getNamedImports().map((named) => ({ decl, named, local: named.getAliasNode()?.getText() ?? named.getName() }));
        const def = decl.getDefaultImport();
        return def ? [...names, { decl, named: null, local: def.getText() }] : names;
    });
}

function usedImportNames(sourceFile) {
    return new Set(
        importedNames(sourceFile)
            .filter(({ local }) => isIdentifierUsed(sourceFile, local))
            .map(({ local }) => local)
    );
}

/** Removes imports that were in use before the transforms and are unused after (e.g. a type only a removed annotation used). */
function removeNewlyUnusedImports(sourceFile, usedBefore) {
    for (const { decl, named, local } of importedNames(sourceFile)) {
        if (!usedBefore.has(local) || isIdentifierUsed(sourceFile, local)) continue;
        if (named) named.remove();
        else decl.removeDefaultImport();
        if (!decl.getDefaultImport() && !decl.getNamespaceImport() && decl.getNamedImports().length === 0) decl.remove();
    }
}

/** Dependencies imported by browser code, as written in the imports (`date-fns`, `date-fns/locale`, …). */
function collectClientDependencies(project, context) {
    const pkg = JSON.parse(fs.readFileSync(path.join(context.root, 'package.json'), 'utf8'));
    const installed = new Set(Object.keys(pkg.dependencies ?? {}));
    // React and React Router are configured by the React Router plugin; the rest only runs on the server.
    const skipped = new Set(['react', 'react-dom', 'react-router', 'next', 'sharp', 'express', 'compression', 'isbot']);
    const found = new Set();
    for (const sourceFile of project.getSourceFiles()) {
        if (/\.server\.tsx?$|\.d\.ts$/.test(sourceFile.getFilePath())) continue;
        for (const decl of sourceFile.getImportDeclarations()) {
            const specifier = decl.getModuleSpecifierValue();
            if (
                /^[./]|^node:|\.(css|scss|sass|less|json)$/.test(specifier) ||
                context.aliases.some(({ prefix }) => specifier.startsWith(prefix))
            )
                continue;
            const hasValue =
                !decl.isTypeOnly() &&
                (Boolean(decl.getDefaultImport()) ||
                    Boolean(decl.getNamespaceImport()) ||
                    decl.getNamedImports().some((named) => !named.isTypeOnly()));
            if (!hasValue) continue;
            const name = /^((?:@[^/]+\/)?[^/]+)/.exec(specifier)[1];
            if (installed.has(name) && !skipped.has(name)) found.add(specifier);
        }
    }
    return [...found].sort();
}

/** Templates that are only written when the converted code needs them. */
function templateCondition(relative, { nextConfig, context, features }) {
    const used = context.report.usedModules;
    switch (relative) {
        case 'app/entry.client.tsx':
            return !nextConfig.reactStrictMode;
        case 'app/lib/dynamic.tsx':
            return used.has('dynamic');
        case 'app/lib/script.tsx':
            return used.has('script');
        case 'app/lib/link.tsx':
            return used.has('link');
        case 'app/lib/image.tsx':
        case 'app/lib/image-optimizer.server.ts':
        case 'app/routes/_image.ts':
            return features.image;
        case 'app/lib/trailing-slash.server.ts':
            return features.trailingSlash;
        default:
            return true;
    }
}

function copyTemplates(context, state) {
    const templatesDir = path.join(context.packageDir, 'templates');
    const provided = providedFiles(context);
    const written = [];
    for (const entry of fs.readdirSync(templatesDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const from = path.join(entry.parentPath, entry.name);
        // Templates carry a `.tmpl` suffix so tools never mistake them for source files.
        const relative = path
            .relative(templatesDir, from)
            .replace(/\.tmpl$/, '')
            .split(path.sep)
            .join('/');
        if (!templateCondition(relative, state)) continue;
        // `app/…` templates go to the project's app directory (which is `src/app` in a src/ layout).
        const destination = relative.startsWith('app/') ? `${context.appDirRelative}/${relative.slice(4)}` : relative;
        if (provided.has(destination)) continue;
        const to = path.join(context.root, destination);
        if (fs.existsSync(to)) throw new CodemodError(`${destination} already exists; the codemod needs to create it.`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        written.push(destination);
    }
    return written;
}

export async function run(argv, packageDir) {
    try {
        await main(argv, packageDir);
    } catch (error) {
        if (error instanceof CodemodError) {
            console.error(`\n\x1b[31m✗ ${error.message}\x1b[0m`);
            process.exit(1);
        }
        throw error;
    }
}

async function main(argv, packageDir) {
    const options = parseArgs(argv, packageDir);
    const root = options.root;
    if (!fs.existsSync(path.join(root, 'package.json'))) throw new CodemodError(`No package.json in ${root}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!pkg.dependencies?.next && !pkg.devDependencies?.next) {
        throw new CodemodError('`next` is not a dependency of this project (already converted, or not a Next.js project).');
    }
    const config = await loadConfig(root, options.config);
    const context = createContext({ root, packageDir, options, config });
    const { pagesDir, appDir, report } = context;
    const exec = (args) => runCommand(...execArgs(context.packageManager, args), root);

    log.step('Checking the project');
    preflight(context);
    const nextConfig = readNextConfig(context);
    checkNextConfig(context, nextConfig);
    const routes = collectPageRoutes(pagesDir);
    if (config.file) log.info(`config: ${path.relative(root, config.file)}`);
    log.ok(`${routes.length} pages`);

    // ------------------------------------------------------------------------------------------
    log.step('Converting source files');
    const project = loadProject(context);
    const provided = providedFiles(context);
    const rootProvided = provided.has(`${context.appDirRelative}/root.tsx`);

    const special = (names, dirs) => dirs.flatMap((dir) => names.map((name) => project.getSourceFile(path.join(dir, name)))).find(Boolean);
    const appFile = special(['_app.tsx', '_app.ts'], [pagesDir]);
    const documentFile = special(['_document.tsx', '_document.ts'], [pagesDir]);
    const errorFile = special(['_error.tsx', '_error.ts'], [pagesDir]);
    const middlewareFile = special(['middleware.ts', 'proxy.ts'], [...new Set([root, context.baseDir])]);
    const nextEnvFile = project.getSourceFile(path.join(root, 'next-env.d.ts'));
    if (nextEnvFile) project.removeSourceFile(nextEnvFile);
    if (errorFile) {
        context.warn('pages/_error is not converted; errors are rendered by the ErrorBoundary in app/root.tsx.');
        project.removeSourceFile(errorFile);
    }
    const pageTypeNames = collectPageTypeNames(appFile);
    // Files a hand-written replacement takes the place of are not converted.
    const removedSources = [];
    if (rootProvided) {
        for (const file of [appFile, documentFile]) {
            if (!file) continue;
            removedSources.push(file.getFilePath());
            project.removeSourceFile(file);
        }
    }
    const middlewareTarget = middlewareFile
        ? path.join(appDir, `${path.basename(middlewareFile.getFilePath()).replace(/\.ts$/, '')}.server.ts`)
        : null;
    const middlewareProvided = middlewareTarget && provided.has(path.relative(root, middlewareTarget).split(path.sep).join('/'));
    if (middlewareFile && middlewareProvided) {
        removedSources.push(middlewareFile.getFilePath());
        project.removeSourceFile(middlewareFile);
    }

    const responseFactories = collectResponseFactories(project);
    const pageFiles = new Map(routes.map((route) => [path.join(pagesDir, route.file), route]));
    const shellFiles = new Set([appFile, documentFile, middlewareFile].filter((file) => file && !file.wasForgotten()));
    const fontPackages = {};
    const fontCss = [];
    const counts = {};
    const count = (name, changed) => {
        if (changed) counts[name] = (counts[name] ?? 0) + 1;
    };

    for (const sourceFile of project.getSourceFiles()) {
        const sideEffectsBefore = sideEffectImports(sourceFile);
        const usedBefore = usedImportNames(sourceFile);
        const route = pageFiles.get(sourceFile.getFilePath());

        if (/<style\s+jsx/.test(sourceFile.getFullText())) {
            throw new CodemodError(
                `${sourceFile.getFilePath()}: styled-jsx (<style jsx>) is not supported. Move the styles to a CSS file first.`
            );
        }
        count("'use client' directives removed", removeUseClient(sourceFile));
        count('process.env → import.meta.env', transformEnv(sourceFile, report));
        const font = transformFont(sourceFile, context);
        if (font) {
            Object.assign(fontPackages, font.packages);
            fontCss.push(...font.css);
            count('next/font', true);
        }
        count('image file imports', transformStaticImageImports(sourceFile, context));
        count('next/image', transformImage(sourceFile, context));
        count('next/dynamic', transformDynamic(sourceFile, context));
        count('next/link', transformLink(sourceFile, context));
        count('next/router', transformRouter(sourceFile, context));
        count('next/head', transformHead(sourceFile));
        count('next/script', transformScript(sourceFile, context));
        count('route pattern strings', transformRoutePatternLiterals(sourceFile));
        if (transformImageEndpointLiterals(sourceFile)) {
            report.usedModules.add('image');
            count('/_next/image → /_image', true);
        }
        const dataFunctions = transformDataFunctions(sourceFile, { responseFactories, context });
        count('getServerSideProps / getStaticProps → loader', dataFunctions.changed);
        if (!shellFiles.has(sourceFile)) count('NextPage types', transformPageTypes(sourceFile, pageTypeNames));
        count('React 19: JSX namespace', transformGlobalJsxNamespace(sourceFile));
        count('React 19: useRef() argument', transformUseRefWithoutArgument(sourceFile));
        count('React 19: RefObject types', transformRefObjectTypes(sourceFile));
        count('React 19: ref callback return values', transformRefCallbackReturns(sourceFile));
        count('React 19: onInput handler types', transformOnInputHandlers(sourceFile));
        count('React 19: fetchPriority attribute', transformFetchPriorityAttribute(sourceFile));

        if (route) {
            for (const name of ['getStaticPaths', 'getInitialProps']) {
                if (sourceFile.getExportedDeclarations().has(name)) {
                    throw new CodemodError(`${sourceFile.getFilePath()}: ${name} is not supported.`);
                }
            }
            count('page statics (getLayout, …) → handle', transformPageStatics(sourceFile));
            if (dataFunctions.loader) count('pages receiving loaderData', wrapPageWithLoaderData(sourceFile));
            if (route.pattern === '/404') addStatusLoader(sourceFile, 404);
            if (route.pattern === '/500') addStatusLoader(sourceFile, 500);
        }

        if (shellFiles.has(sourceFile)) continue; // checked after they are rebuilt below
        removeNewlyUnusedImports(sourceFile, usedBefore);
        // Side-effect imports (`import './x.scss'`) must survive every transform.
        const sideEffectsAfter = new Set(sideEffectImports(sourceFile));
        const lost = sideEffectsBefore.filter((specifier) => !sideEffectsAfter.has(specifier));
        if (lost.length > 0) {
            throw new CodemodError(
                `${sourceFile.getFilePath()}: side-effect imports were lost during conversion (a bug in this codemod): ${lost.join(', ')}`
            );
        }
        const leftover = sourceFile.getImportDeclarations().find((decl) => /^next(\/|$)/.test(decl.getModuleSpecifierValue()));
        if (leftover) {
            throw new CodemodError(`${sourceFile.getFilePath()}: this import from Next.js cannot be converted: ${leftover.getText()}`);
        }
    }

    // Server middleware (was middleware.ts / proxy.ts)
    const middleware = [];
    const features = {
        image: false,
        // Next.js redirects `/about/` to `/about` unless told otherwise; when the project provides its own
        // root, it is responsible for that too.
        trailingSlash: !rootProvided && !nextConfig.skipTrailingSlashRedirect && !nextConfig.trailingSlash,
    };
    if (features.trailingSlash) {
        middleware.push({ name: 'trailingSlashRedirect', file: path.join(appDir, 'lib/trailing-slash.server') });
    }
    if (middlewareFile && !middlewareProvided) {
        const oldPath = middlewareFile.getFilePath();
        const { name } = transformMiddleware(middlewareFile, context, { fromDir: path.dirname(oldPath), toFile: middlewareTarget });
        // (not SourceFile.move(): it would adjust the relative imports a second time)
        project.createSourceFile(middlewareTarget, middlewareFile.getFullText(), { overwrite: true });
        project.removeSourceFile(middlewareFile);
        removedSources.push(oldPath);
        middleware.push({ name, file: middlewareTarget.replace(/\.ts$/, '') });
        count('middleware', true);
    }

    // pages/_app + pages/_document → app/root.tsx
    if (!rootProvided) {
        // (the pages have not moved yet: rewriteImportsAfterMove points this import at app/routes/ afterwards)
        const notFoundRoute = routes.find((route) => route.pattern === '/404');
        const notFoundPage = notFoundRoute ? path.join(pagesDir, notFoundRoute.file.replace(/\.[^.]+$/, '').replace(/\/index$/, '')) : null;
        const rootFile = buildRootFile(project, context, { appFile, documentFile, middleware, notFoundPage });
        for (const file of [appFile, documentFile]) {
            if (!file) continue;
            removedSources.push(file.getFilePath());
            project.removeSourceFile(file);
        }
        const leftover = rootFile.getImportDeclarations().find((decl) => /^next(\/|$)/.test(decl.getModuleSpecifierValue()));
        if (leftover)
            throw new CodemodError(`pages/_app or pages/_document: this import from Next.js cannot be converted: ${leftover.getText()}`);
        count(`_app / _document → ${context.appDirRelative}/root.tsx`, true);
    }

    project.saveSync();
    features.image = report.usedModules.has('image');
    const clientDependencies = collectClientDependencies(project, context);
    for (const [name, value] of Object.entries(counts)) log.info(`${name}: ${value} file${value === 1 ? '' : 's'}`);

    // ------------------------------------------------------------------------------------------
    log.step(`Moving pages/ → ${context.appDirRelative}/routes/`);
    for (const file of removedSources) fs.rmSync(file, { force: true });
    const routesDir = path.join(appDir, 'routes');
    if (fs.existsSync(routesDir)) {
        // app/ only holds files the codemod just wrote (root.tsx, middleware); routes/ cannot exist yet
        throw new CodemodError(`${path.relative(root, routesDir)} already exists.`);
    }
    fs.mkdirSync(appDir, { recursive: true });
    fs.renameSync(pagesDir, routesDir);
    log.ok(`imports rewritten in ${rewriteImportsAfterMove(context, pagesDir, routesDir)} files`);

    // ------------------------------------------------------------------------------------------
    log.step('Writing React Router / Vite files');
    const envFiles = updateEnvFiles(context);
    const written = [...copyTemplates(context, { nextConfig, context, features }), ...copyProvidedFiles(context)];
    if (fontCss.length > 0) {
        fs.writeFileSync(
            context.modulePath('fonts'),
            `/* Fonts (were next/font). The font files come from the @fontsource packages. */\n${[...new Set(fontCss)].join('\n\n')}\n`
        );
        written.push(`${context.appDirRelative}/fonts.css`);
    }
    if (features.image) {
        writeImageConfig(context, nextConfig);
        written.push(`${context.appDirRelative}/lib/image-config.ts`);
    }
    const extraRoutes = [];
    if (features.image) {
        extraRoutes.push({ comment: 'image optimization', path: '_image', moduleFile: 'routes/_image.ts', id: '/_image' });
        if (config.value.legacyImageRoute !== false) {
            extraRoutes.push({
                comment: 'image URLs from the Next.js days (still referenced by published pages and feeds)',
                path: '_next/image',
                moduleFile: 'routes/_image.ts',
                id: '/_next/image',
            });
        }
    }
    fs.writeFileSync(
        path.join(appDir, 'routes.ts'),
        renderRoutesFile(routes, {
            layouts: config.value.routes?.layouts ?? [],
            notFoundPage: routes.find((route) => route.pattern === '/404'),
            extraRoutes,
        })
    );
    written.push(`${context.appDirRelative}/routes.ts`);
    // env.d.ts also declares the variables used by generated and provided files
    for (const file of listFiles(appDir, (candidate) => /\.tsx?$/.test(candidate))) {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) report.publicEnv.add(match[1]);
    }
    writeEnvTypes(context);
    written.push('env.d.ts');
    fillBuildConfigs(context, clientDependencies);
    for (const file of written.sort()) log.info(file);

    // ------------------------------------------------------------------------------------------
    log.step('Updating configuration files');
    if (!options.skipInstall && context.packageManager === 'npm' && fs.existsSync(path.join(root, 'package-lock.json'))) {
        // Drop the Next.js packages from the lockfile first: with them still locked, npm resolves the new
        // dependencies against their stale peer requirements and fails.
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const present = REMOVED_PACKAGES.filter((name) => pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
        runCommand(
            'npm',
            ['uninstall', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'error', ...present],
            root
        );
    }
    updatePackageJson(context, { extraDependencies: fontPackages, features });
    updateTsconfig(context);
    updateEslintConfig(context);
    updateIgnoreFiles(context);
    updateTailwindConfig(context);
    const renamed = renameCommonJsConfigs(context);
    const skip = context.packageDirInProject ? [path.join(root, context.packageDirInProject)] : [];
    const replaced = applyTextReplacements(context, (dir, filter) => listFiles(dir, filter, skip));
    for (const name of [...NEXT_CONFIG_NAMES, 'next-env.d.ts', 'tsconfig.tsbuildinfo']) fs.rmSync(path.join(root, name), { force: true });
    fs.rmSync(path.join(root, '.next'), { recursive: true, force: true });
    log.ok('package.json, tsconfig.json, ESLint, ignore files');
    if (envFiles.length > 0) log.ok(`NEXT_PUBLIC_* → VITE_* in ${envFiles.join(', ')}`);
    for (const [from, to] of renamed) log.ok(`${from} → ${to} (package.json is now "type": "module")`);
    if (replaced.length > 0) log.ok(`text replacements: ${replaced.join(', ')}`);

    // ------------------------------------------------------------------------------------------
    let verified = null;
    if (!options.skipInstall) {
        log.step(`Installing dependencies (${context.packageManager} install)`);
        const install = INSTALL[context.packageManager];
        if (!runCommand(context.packageManager, install.args, root, { ...process.env, ...install.env })) {
            throw new CodemodError('Installing dependencies failed.');
        }

        log.step('Generating route types (react-router typegen)');
        if (!exec(['react-router', 'typegen'])) throw new CodemodError('react-router typegen failed.');

        if (fs.existsSync(path.join(root, 'node_modules', 'prettier'))) {
            log.step('Formatting changed files (prettier)');
            const changed = changedFiles(context).filter(
                (file) => /\.(tsx?|jsx?|mjs|cjs|json|scss|css)$/.test(file) && !/(^|\/)package(-lock)?\.json$/.test(file)
            );
            if (changed.length > 0)
                exec(['prettier', '--write', '--ignore-unknown', '--log-level', 'warn', ...changed]) ||
                    exec(['prettier', '--write', '--ignore-unknown', '--loglevel', 'warn', ...changed]);
        }

        if (!options.skipVerify) {
            log.step('Verifying (type check, build, loading the server build)');
            verified =
                runCommand(context.packageManager, ['run', 'typecheck'], root) &&
                runCommand(context.packageManager, ['run', 'build'], root) &&
                verifyServerBuild(context);
        }

        const suspects = findDefaultPropsLibraries(context);
        if (suspects.length > 0) {
            context.warn(
                `These libraries set defaultProps: ${suspects.join(', ')}. React 19 ignores defaultProps on function components; check the screens that use them.`
            );
        }
    }

    // ------------------------------------------------------------------------------------------
    log.step('Done');
    if (verified === true) log.ok('Type check and build passed');
    if (verified === false) log.warn('Type check or build failed; see the output above');
    for (const warning of report.warnings) log.warn(warning);
    const run = context.packageManager === 'npm' ? 'npm run' : context.packageManager;
    const lines = [
        '',
        `  Development:  ${run} dev`,
        `  Production:   ${run} build && ${run} start   (PORT sets the port, default 3000)`,
        '',
        '  Left for you to do:',
    ];
    if (envFiles.length > 0 || report.publicEnv.size > 0) {
        lines.push('  - Rename NEXT_PUBLIC_* to VITE_* wherever the environment is defined outside this repository (CI, servers).');
    }
    if (report.serverEnv.size > 0) {
        lines.push(
            `  - ${[...report.serverEnv].join(', ')}: read from process.env at run time on the server (\`${run} start\` loads .env).`
        );
    }
    lines.push('  - Pages that Next.js generated statically are now rendered on the server for every request.');
    lines.push('  - Review the diff, then run the app and click through it.');
    if ((config.value.notes ?? []).length > 0)
        lines.push('', '  Notes for this project:', ...config.value.notes.map((note) => `  - ${note}`));
    console.log(`${lines.join('\n')}\n`);
    if (verified === false) process.exit(1);
}

/**
 * Loads the server build in Node.js. Some dependencies cannot be loaded as ES modules as published
 * (CommonJS without detectable named exports, missing file extensions, …). When loading fails because of a
 * package, add it to `ssr.noExternal` in vite.config.ts (so it is bundled) and build again.
 */
function verifyServerBuild(context) {
    const { root } = context;
    const configFile = path.join(root, 'vite.config.ts');
    const bundled = [];
    for (let attempt = 0; attempt < 20; attempt++) {
        const result = spawnSync(
            process.execPath,
            ['--input-type=module', '-e', "await import('./build/server/index.js'); process.exit(0);"],
            {
                cwd: root,
                encoding: 'utf8',
                timeout: 120_000,
                env: { ...process.env, NODE_ENV: 'production' },
            }
        );
        if (result.status === 0) {
            if (bundled.length > 0) log.ok(`added to ssr.noExternal: ${bundled.join(', ')}`);
            return true;
        }
        const stderr = result.stderr ?? '';
        const specifier =
            /The requested module '([^']+)' is a CommonJS module/.exec(stderr)?.[1] ??
            /The requested module '([^']+)' does not provide an export named/.exec(stderr)?.[1] ??
            /Directory import '([^']+)' is not supported/.exec(stderr)?.[1] ??
            /Cannot find module '([^']+)' imported from/.exec(stderr)?.[1] ??
            /node_modules\/((?:@[^/\s]+\/)?[^/\s:]+)\/[^\n]*\n[^\n]*\n[^\n]*\n+SyntaxError: (?:Cannot use import statement|Unexpected token 'export')/.exec(
                stderr
            )?.[1];
        const fromNodeModules = specifier && /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(specifier)?.[1];
        const name = fromNodeModules ?? (specifier && !/^[./]/.test(specifier) ? /^((?:@[^/]+\/)?[^/]+)/.exec(specifier)?.[1] : null);
        if (!name || bundled.includes(name)) {
            console.error(stderr);
            log.warn('The server build (build/server/index.js) could not be loaded');
            return false;
        }
        bundled.push(name);
        const source = fs.readFileSync(configFile, 'utf8');
        const output = source.replace(/noExternal: \[[^\]]*\]/, `noExternal: [${bundled.map((item) => `'${item}'`).join(', ')}]`);
        if (output === source) {
            log.warn(`Could not add ${name} to ssr.noExternal in vite.config.ts`);
            return false;
        }
        fs.writeFileSync(configFile, output);
        log.info(`${name} cannot be loaded by Node.js as published; bundling it into the server build`);
        if (!runCommand(context.packageManager, ['run', 'build', '--silent'], root)) return false;
    }
    return false;
}

/** Dependencies whose published code assigns `X.defaultProps = …`. */
function findDefaultPropsLibraries(context) {
    const { root, config } = context;
    const reviewed = new Set(config.value.reviewedLibraries ?? []);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const suspects = [];
    for (const name of Object.keys(pkg.dependencies ?? {})) {
        if (reviewed.has(name)) continue;
        const dir = path.join(root, 'node_modules', name);
        if (!fs.existsSync(dir)) continue;
        let budget = 400;
        const scan = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (budget <= 0) return false;
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (['node_modules', 'umd', 'src', 'test', 'tests', '__tests__'].includes(entry.name)) continue;
                    if (scan(full)) return true;
                } else if (/\.(c|m)?js$/.test(entry.name) && !/\.min\./.test(entry.name)) {
                    budget--;
                    if (/\.defaultProps\s*=/.test(fs.readFileSync(full, 'utf8'))) return true;
                }
            }
            return false;
        };
        if (scan(dir)) suspects.push(name);
    }
    return suspects;
}

/** Files git sees as changed or new (all files when the project is not a git repository). */
function changedFiles(context) {
    const { root } = context;
    const skip = context.packageDirInProject ? [path.join(root, context.packageDirInProject)] : [];
    if (!fs.existsSync(path.join(root, '.git'))) {
        return listFiles(root, () => true, skip).map((file) => path.relative(root, file));
    }
    const pathspec = ['.', ...(context.packageDirInProject ? [`:(exclude)${context.packageDirInProject}`] : [])];
    const output = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspec], {
        cwd: root,
        encoding: 'utf8',
    });
    const files = [];
    const entries = output.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
        const status = entries[i].slice(0, 2);
        const file = entries[i].slice(3);
        if (status.includes('R')) i++; // a rename is two entries: the new name, then the old one
        if (status.includes('D')) continue;
        if (fs.existsSync(path.join(root, file))) files.push(file);
    }
    return files;
}
