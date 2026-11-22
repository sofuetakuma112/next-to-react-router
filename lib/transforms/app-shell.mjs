// pages/_app.tsx + pages/_document.tsx → app/root.tsx
//
//   _document: <Html><Head>…</Head><body><Main /><NextScript /></body></Html>
//           → export function Layout({ children }) { <html><head>…<Meta /><Links /></head><body>{children}…</body></html> }
//   _app:      export default function App({ Component, pageProps }) { … <Component {...pageProps} /> … }
//           → export default function App() { … <Outlet /> … }
//
// `Component.getLayout` (and any other static read off the page component) becomes a read of the matched
// route's `handle`, and `pageProps` becomes the matched route's loader data.
import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { Edits, addNamedImport, enclosingFunction, findImport, isIdentifierUsed, jsxOpeningsByTag, unsupported } from '../util.mjs';
import { transformRouterBinding } from './router.mjs';

const OVERRIDE_HINT = 'Provide app/root.tsx yourself through the "files" option of next-to-react-router.config.mjs.';

/** Type aliases declared in _app that describe a page component (e.g. `NextPageWithLayout`). */
export function collectPageTypeNames(appFile) {
    const names = new Set(['NextPage']);
    if (!appFile) return names;
    for (const alias of appFile.getTypeAliases()) {
        if (/\bNextPage\b/.test(alias.getTypeNodeOrThrow().getText())) names.add(alias.getName());
    }
    return names;
}

function defaultExportFunction(sourceFile) {
    const declaration = sourceFile.getFunctions().find((fn) => fn.isDefaultExport());
    if (declaration) return declaration;
    const assignment = sourceFile.getExportAssignment((candidate) => !candidate.isExportEquals());
    const expression = assignment?.getExpression();
    if (!expression) return null;
    if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) return expression;
    if (Node.isIdentifier(expression)) {
        const name = expression.getText();
        const fn = sourceFile.getFunction(name);
        if (fn) return fn;
        const initializer = sourceFile.getVariableDeclaration(name)?.getInitializer();
        if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) return initializer;
        const classDeclaration = sourceFile.getClass(name);
        if (classDeclaration) return classDeclaration;
    }
    return sourceFile.getClasses().find((candidate) => candidate.isDefaultExport()) ?? null;
}

/** The statement that holds the default-exported component, plus a trailing `export default X;` if there is one. */
function defaultExportStatements(sourceFile, component) {
    const statements = new Set();
    let top = component;
    while (top.getParent() && !Node.isSourceFile(top.getParent())) top = top.getParent();
    statements.add(top);
    const assignment = sourceFile.getExportAssignment((candidate) => !candidate.isExportEquals());
    if (assignment) statements.add(assignment);
    return statements;
}

function returnedJsx(fn, file) {
    const body = Node.isClassDeclaration(fn) ? fn.getMethod('render')?.getBody() : fn.getBody();
    if (!body) unsupported(fn, `${file}: could not find what the component renders. ${OVERRIDE_HINT}`);
    if (!Node.isBlock(body)) return { expression: body, statements: [] };
    const statements = body.getStatements();
    const last = statements[statements.length - 1];
    if (!last || !Node.isReturnStatement(last) || !last.getExpression()) {
        unsupported(fn, `${file}: the component must end with a single return statement. ${OVERRIDE_HINT}`);
    }
    return { expression: last.getExpressionOrThrow(), statements: statements.slice(0, -1) };
}

function unwrap(expression) {
    let current = expression;
    while (Node.isParenthesizedExpression(current)) current = current.getExpression();
    return current;
}

function attributesText(opening) {
    return opening
        .getAttributes()
        .map((attribute) => attribute.getText())
        .join(' ');
}

/** Reads the pieces of `<Html><Head>…</Head><body>…</body></Html>` out of pages/_document.tsx. */
function readDocument(documentFile) {
    const empty = {
        htmlAttributes: '',
        headChildren: '',
        bodyAttributes: '',
        bodyChildren: '{children}\n<ScrollRestoration />\n<Scripts />',
        statements: '',
    };
    if (!documentFile) return empty;

    const decl = findImport(documentFile, 'next/document')[0];
    const names = Object.fromEntries(
        (decl?.getNamedImports() ?? []).map((named) => [named.getName(), named.getAliasNode()?.getText() ?? named.getName()])
    );
    const component = defaultExportFunction(documentFile);
    if (!component) unsupported(documentFile, `pages/_document: no default export found. ${OVERRIDE_HINT}`);
    if (Node.isClassDeclaration(component)) {
        const members = component.getMembers().filter((member) => !(Node.isMethodDeclaration(member) && member.getName() === 'render'));
        if (members.length > 0) {
            unsupported(
                members[0],
                `pages/_document: custom Document classes with members other than render() are not supported. ${OVERRIDE_HINT}`
            );
        }
    }
    if (/getInitialProps/.test(documentFile.getFullText())) {
        unsupported(component, `pages/_document: getInitialProps is not supported. ${OVERRIDE_HINT}`);
    }

    const { expression, statements } = returnedJsx(component, 'pages/_document');
    const html = unwrap(expression);
    if (!Node.isJsxElement(html) || html.getOpeningElement().getTagNameNode().getText() !== (names.Html ?? 'Html')) {
        unsupported(expression, `pages/_document: expected <Html> at the top of the returned JSX. ${OVERRIDE_HINT}`);
    }
    const children = html.getJsxChildren().filter((child) => child.getText().trim() !== '');
    const tagOf = (node) =>
        Node.isJsxElement(node)
            ? node.getOpeningElement().getTagNameNode().getText()
            : Node.isJsxSelfClosingElement(node)
              ? node.getTagNameNode().getText()
              : null;
    const head = children.find((child) => tagOf(child) === (names.Head ?? 'Head'));
    const body = children.find((child) => tagOf(child) === 'body');
    if (!body || !Node.isJsxElement(body) || children.length !== (head ? 2 : 1)) {
        unsupported(html, `pages/_document: expected exactly <Head> and <body> inside <Html>. ${OVERRIDE_HINT}`);
    }

    const full = documentFile.getFullText();
    const inner = (element) =>
        Node.isJsxElement(element) ? full.slice(element.getOpeningElement().getEnd(), element.getClosingElement().getStart()) : '';
    let bodyChildren = inner(body);
    const mainTag = new RegExp(`<${names.Main ?? 'Main'}\\s*/>`);
    const scriptTag = new RegExp(`<${names.NextScript ?? 'NextScript'}\\s*/>`);
    if (!mainTag.test(bodyChildren) || !scriptTag.test(bodyChildren)) {
        unsupported(body, `pages/_document: expected <Main /> and <NextScript /> inside <body>. ${OVERRIDE_HINT}`);
    }
    bodyChildren = bodyChildren.replace(mainTag, '{children}').replace(scriptTag, '<ScrollRestoration />\n<Scripts />');

    return {
        htmlAttributes: attributesText(html.getOpeningElement()),
        headChildren: head ? inner(head).trim() : '',
        bodyAttributes: attributesText(body.getOpeningElement()),
        bodyChildren: bodyChildren.trim(),
        statements: statements.map((statement) => statement.getText()).join('\n'),
        component,
    };
}

/** Rewrites the default-exported App component of pages/_app.tsx in place. Returns the component node's new text. */
function rewriteApp(appFile, context) {
    const component = defaultExportFunction(appFile);
    if (!component || Node.isClassDeclaration(component)) {
        unsupported(component ?? appFile, `pages/_app: expected a function component as the default export. ${OVERRIDE_HINT}`);
    }
    if (/getInitialProps/.test(appFile.getFullText()))
        unsupported(component, `pages/_app: getInitialProps is not supported. ${OVERRIDE_HINT}`);

    const param = component.getParameters()[0];
    const pattern = param?.getNameNode();
    if (param && !Node.isObjectBindingPattern(pattern)) {
        unsupported(param, `pages/_app: destructure the props ({ Component, pageProps }). ${OVERRIDE_HINT}`);
    }
    const bound = {};
    for (const element of pattern?.getElements() ?? []) {
        if (element.getDotDotDotToken()) unsupported(element, `pages/_app: rest props are not supported. ${OVERRIDE_HINT}`);
        bound[element.getPropertyNameNode()?.getText() ?? element.getName()] = element;
    }
    for (const name of Object.keys(bound)) {
        if (!['Component', 'pageProps', 'router'].includes(name))
            unsupported(bound[name], `pages/_app: the ${name} prop is not supported. ${OVERRIDE_HINT}`);
    }

    const edits = new Edits(appFile);
    const imports = [];
    const declarations = [];
    let needsLeaf = false;

    // <Component {...pageProps} /> → <Outlet />
    const componentName = bound.Component?.getName();
    const handled = new Set();
    if (componentName) {
        for (const element of jsxOpeningsByTag(appFile, componentName)) {
            if (enclosingFunction(element) !== component && !element.getFirstAncestor((ancestor) => ancestor === component)) continue;
            if (!Node.isJsxSelfClosingElement(element))
                unsupported(element, `pages/_app: <${componentName}> with children is not supported. ${OVERRIDE_HINT}`);
            edits.replace(element, '<Outlet />');
            imports.push(['react-router', 'Outlet']);
            element.getDescendantsOfKind(SyntaxKind.Identifier).forEach((id) => handled.add(id));
        }
        // Component.getLayout (or any other static) → handle?.getLayout
        for (const id of component.getDescendantsOfKind(SyntaxKind.Identifier)) {
            if (id.getText() !== componentName || handled.has(id) || id === bound.Component.getNameNode()) continue;
            const access = id.getParent();
            if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== id) {
                unsupported(id, `pages/_app: this use of ${componentName} is not supported. ${OVERRIDE_HINT}`);
            }
            edits.replace(access, `handle?.${access.getName()}`);
            needsLeaf = true;
            if (!declarations.includes('handle')) declarations.push('handle');
        }
    }

    // pageProps → the matched route's loader data
    const pagePropsName = bound.pageProps?.getName();
    if (pagePropsName) {
        const used = component
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .some((id) => id.getText() === pagePropsName && !handled.has(id) && id !== bound.pageProps.getNameNode());
        if (used) {
            needsLeaf = true;
            declarations.push('pageProps');
        }
    }

    const body = component.getBody();
    const lines = [];
    if (needsLeaf) {
        imports.push(['react-router', 'useMatches']);
        lines.push('const matches = useMatches();', 'const leaf = matches[matches.length - 1];');
        if (declarations.includes('handle')) lines.push('const handle = leaf?.handle as RouteHandle | undefined;');
        if (declarations.includes('pageProps')) lines.push(`const ${pagePropsName} = (leaf?.loaderData ?? {}) as Record<string, any>;`);
    }

    // router prop → hooks
    if (bound.router) {
        transformRouterBinding(
            edits,
            {
                fn: component,
                name: bound.router.getName(),
                declarationName: bound.router.getNameNode(),
                writeDeclarations: (routerLines) => lines.push(...routerLines),
            },
            imports,
            context,
            appFile
        );
    }

    if (param) edits.replaceRange(param.getStart(), param.getEnd(), '');
    if (lines.length > 0) {
        if (Node.isBlock(body)) {
            edits.insert(body.getStart() + 1, `\n${lines.join('\n')}`);
        } else {
            edits.insertBefore(body, `{\n${lines.join('\n')}\nreturn `);
            edits.insertAfter(body, ';\n}');
        }
    }
    edits.apply();
    return imports;
}

/**
 * Builds app/root.tsx. `appFile` / `documentFile` are the (already transformed) source files, or undefined.
 * @param middleware Server middleware to run on every request: `{ name, file }[]` (file: absolute, no extension)
 */
export function buildRootFile(project, context, { appFile, documentFile, middleware, notFoundPage }) {
    const rootPath = path.join(context.appDir, 'root.tsx');
    const imports = appFile ? rewriteApp(appFile, context) : [];
    const document = readDocument(documentFile);

    const importLines = [];
    const bodyStatements = [];
    const carry = (sourceFile, skipped) => {
        if (!sourceFile) return;
        for (const statement of sourceFile.getStatements()) {
            if (Node.isImportDeclaration(statement)) {
                const specifier = statement.getModuleSpecifierValue();
                if (/^next(\/|$)/.test(specifier)) continue;
                // Relative imports were written relative to pages/; root.tsx lives in the app directory.
                const text = specifier.startsWith('.')
                    ? statement.getText().replace(/(['"])[^'"]+\1\s*;?\s*$/, (match, quote) => {
                          let rebased = path.relative(context.appDir, path.resolve(context.pagesDir, specifier)).split(path.sep).join('/');
                          if (!rebased.startsWith('.')) rebased = `./${rebased}`;
                          return `${quote}${rebased}${quote};`;
                      })
                    : statement.getText();
                importLines.push(text);
            } else if (!skipped.has(statement)) {
                // Types built on Next's AppProps / NextPage have no meaning any more.
                if (
                    (Node.isTypeAliasDeclaration(statement) || Node.isInterfaceDeclaration(statement)) &&
                    /\b(AppProps|NextPage|NextComponentType)\b/.test(statement.getText())
                )
                    continue;
                bodyStatements.push(statement.getText());
            }
        }
    };

    let appComponentText = 'export default function App() {\n    return <Outlet />;\n}';
    if (appFile) {
        const component = defaultExportFunction(appFile);
        const skipped = defaultExportStatements(appFile, component);
        carry(appFile, skipped);
        const name = Node.isFunctionDeclaration(component) ? component.getName() : null;
        let text = component.getText().replace(/^export\s+default\s+/, '');
        if (!Node.isFunctionDeclaration(component)) text = `const App = ${text};`;
        appComponentText = `${text}\n\nexport default ${name ?? 'App'};`;
    }
    if (documentFile) carry(documentFile, defaultExportStatements(documentFile, document.component));

    const middlewareLines = [];
    // `middleware` is the name of the export below, so a middleware function of that name is imported under another
    const localName = (entry) => (entry.name === 'middleware' ? 'requestMiddleware' : entry.name);
    for (const entry of middleware) {
        const binding = localName(entry) === entry.name ? entry.name : `${entry.name} as ${localName(entry)}`;
        importLines.push(`import { ${binding} } from '${context.specifier(rootPath, entry.file)}';`);
    }
    if (middleware.length > 0) {
        middlewareLines.push(
            '// Runs on the server before every request.',
            `export const middleware = [${middleware.map(localName).join(', ')}];`,
            ''
        );
    }

    // Loaders answer "not found" by throwing a 404; show the project's 404 page for it, like Next.js did.
    if (notFoundPage) importLines.push(`import NotFoundPage from '${context.specifier(rootPath, notFoundPage)}';`);

    const attributes = (text) => (text ? ` ${text}` : '');
    const source = [
        ...importLines,
        '',
        '/** What a route module can export as `handle`. `getLayout` wraps the page (see the App component below). */',
        'export interface RouteHandle {',
        '    getLayout?: (page: ReactElement) => ReactNode;',
        '    [key: string]: unknown;',
        '}',
        '',
        ...middlewareLines,
        ...bodyStatements.flatMap((statement) => [statement, '']),
        'export function Layout({ children }: { children: ReactNode }) {',
        ...(document.statements ? [document.statements] : []),
        '    return (',
        `        <html${attributes(document.htmlAttributes)}>`,
        '            <head>',
        '                <meta charSet="utf-8" />',
        '                <meta name="viewport" content="width=device-width" />',
        '                <Meta />',
        '                <Links />',
        document.headChildren,
        '            </head>',
        `            <body${attributes(document.bodyAttributes)}>`,
        document.bodyChildren,
        '            </body>',
        '        </html>',
        '    );',
        '}',
        '',
        appComponentText,
        '',
        'export function ErrorBoundary() {',
        '    const error = useRouteError();',
        '    const status = isRouteErrorResponse(error) ? error.status : 500;',
        ...(notFoundPage ? ['    if (status === 404) return <NotFoundPage />;'] : []),
        '',
        '    return (',
        "        <main style={{ fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: '80px 20px' }}>",
        '            <h1>{status}</h1>',
        "            <p>{status === 404 ? 'This page could not be found.' : 'An unexpected error occurred.'}</p>",
        '        </main>',
        '    );',
        '}',
        '',
    ].join('\n');

    const rootFile = project.createSourceFile(rootPath, source, { overwrite: true });
    for (const name of ['Links', 'Meta', 'Outlet', 'Scripts', 'isRouteErrorResponse', 'useRouteError']) {
        addNamedImport(rootFile, 'react-router', name);
    }
    // React Router's ScrollRestoration, made to wait for pages that load their content in the browser
    addNamedImport(rootFile, context.moduleSpecifier(rootFile, 'scrollRestoration'), 'ScrollRestoration');
    for (const [moduleName, name, options] of imports) addNamedImport(rootFile, moduleName, name, options);
    for (const name of ['ReactElement', 'ReactNode']) addNamedImport(rootFile, 'react', name, { typeOnly: true });
    // Imports that only the removed parts used (AppProps helpers, etc.)
    for (const decl of rootFile.getImportDeclarations()) {
        if (!decl.getImportClause()) continue;
        for (const named of decl.getNamedImports()) {
            if (!isIdentifierUsed(rootFile, named.getAliasNode()?.getText() ?? named.getName())) named.remove();
        }
        const def = decl.getDefaultImport();
        if (def && !isIdentifierUsed(rootFile, def.getText())) decl.removeDefaultImport();
        if (!decl.getDefaultImport() && !decl.getNamespaceImport() && decl.getNamedImports().length === 0) decl.remove();
    }
    return rootFile;
}
