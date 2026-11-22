// middleware.ts / proxy.ts (Next.js middleware) → a React Router server middleware module
//
//   export function middleware(request: NextRequest) {       export const middleware: MiddlewareFunction<Response> =
//       if (…) return NextResponse.redirect(url);        →       async ({ request, url }, next) => {
//       return NextResponse.next();                                   if (…) return redirect(String(url), 307);
//   }                                                                 return next();
//   export const config = { matcher: […] };                       };
import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { Edits, addNamedImport, enclosingFunction, findImport, unsupported } from '../util.mjs';

/** A Next.js matcher (path-to-regexp syntax, regex groups allowed) as a regular expression source. */
export function matcherToRegExpSource(matcher) {
    const source = matcher
        .replace(/\/:[A-Za-z_]\w*\*/g, '(?:/.*)?')
        .replace(/\/:[A-Za-z_]\w*\+/g, '/.+')
        .replace(/\/:[A-Za-z_]\w*\?/g, '(?:/[^/]+)?')
        .replace(/:[A-Za-z_]\w*/g, '[^/]+');
    return `^${source}$`;
}

function readMatchers(sourceFile) {
    const config = sourceFile.getVariableDeclaration('config');
    if (!config?.isExported()) return { statement: null, matchers: null };
    const statement = config.getVariableStatementOrThrow();
    const initializer = config.getInitializer();
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) unsupported(config, 'middleware config must be an object literal');
    const property = initializer.getProperty('matcher');
    if (!property) return { statement, matchers: null };
    if (!Node.isPropertyAssignment(property)) unsupported(property, 'middleware matcher must be a plain property');
    const value = property.getInitializerOrThrow();
    const elements = Node.isArrayLiteralExpression(value) ? value.getElements() : [value];
    const matchers = elements.map((element) => {
        if (!Node.isStringLiteral(element) && !Node.isNoSubstitutionTemplateLiteral(element)) {
            unsupported(element, 'Only string matchers are supported (not objects with has / missing)');
        }
        return element.getLiteralValue();
    });
    return { statement, matchers };
}

/**
 * Transforms the middleware source file in place.
 * @returns {{ name: string }} the exported middleware's name
 */
export function transformMiddleware(sourceFile, context, { fromDir, toFile }) {
    const edits = new Edits(sourceFile);
    const exported = ['middleware', 'proxy']
        .map((name) => sourceFile.getFunction(name) ?? sourceFile.getVariableDeclaration(name)?.getInitializer())
        .find(
            (candidate) =>
                candidate &&
                (Node.isFunctionDeclaration(candidate) || Node.isArrowFunction(candidate) || Node.isFunctionExpression(candidate))
        );
    const fn = exported ?? sourceFile.getFunctions().find((candidate) => candidate.isDefaultExport());
    if (!fn) unsupported(sourceFile, 'No exported `middleware` (or `proxy`) function found');
    if (!Node.isFunctionDeclaration(fn)) unsupported(fn, 'Declare the middleware as `export function middleware(request) { … }`');
    const name = fn.getName() ?? 'middleware';
    const body = fn.getBodyOrThrow();
    const params = fn.getParameters();
    if (params.length > 1) unsupported(params[1], 'The second middleware argument (event) is not supported');
    const requestName = params[0]?.getName() ?? 'request';

    const { statement: configStatement, matchers } = readMatchers(sourceFile);
    if (configStatement) edits.removeStatement(configStatement);

    const imports = new Set(['MiddlewareFunction']);
    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const target = access.getExpression().getText();
        const member = access.getName();
        if (member === 'nextUrl') {
            // Inside the middleware itself React Router hands us the parsed URL; elsewhere parse the request's.
            edits.replace(access, enclosingFunction(access) === fn && target === requestName ? 'url' : `new URL(${target}.url)`);
        } else if (['cookies', 'geo', 'ip'].includes(member) && target === requestName) {
            unsupported(access, `request.${member} is not supported; read it from request.headers`);
        } else if (target === 'NextResponse') {
            const call = access.getParent();
            if (!Node.isCallExpression(call) || call.getExpression() !== access)
                unsupported(access, 'This use of NextResponse is not supported');
            const args = call.getArguments();
            if (member === 'next') {
                if (args.length > 0) unsupported(call, 'NextResponse.next() with arguments is not supported');
                if (enclosingFunction(call) !== fn)
                    unsupported(call, 'NextResponse.next() must be called in the middleware function itself');
                edits.replace(access, 'next');
            } else if (member === 'redirect') {
                imports.add('redirect');
                edits.replace(access, 'redirect');
                const [destination] = args;
                if (!destination) unsupported(call, 'NextResponse.redirect() needs a destination');
                if (
                    !Node.isStringLiteral(destination) &&
                    !Node.isNoSubstitutionTemplateLiteral(destination) &&
                    !Node.isTemplateExpression(destination)
                ) {
                    edits.insertBefore(destination, 'String(');
                    edits.insertAfter(destination, ')');
                }
                // NextResponse.redirect defaults to 307, React Router's redirect to 302.
                if (args.length === 1) edits.insertAfter(destination, ', 307');
            } else if (member === 'json') {
                edits.replace(access.getExpression(), 'Response');
            } else {
                unsupported(call, `NextResponse.${member}() is not supported`);
            }
        }
    }
    for (const expression of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (expression.getExpression().getText() === 'NextResponse') edits.replace(expression.getExpression(), 'Response');
    }
    for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
        const typeName = reference.getTypeName().getText();
        // the middleware's own signature is rewritten as a whole below
        if (reference.getStart() >= fn.getStart() && reference.getEnd() <= body.getStart()) continue;
        if (typeName === 'NextRequest') edits.replace(reference, 'Request');
        else if (typeName === 'NextResponse') edits.replace(reference, 'Response');
        else if (typeName === 'NextFetchEvent') unsupported(reference, 'NextFetchEvent is not supported');
    }

    // function middleware(request) { … } → const handleMiddleware: MiddlewareFunction<Response> = async ({ request, url }, next) => { … };
    // and an exported `middleware` around it that makes same-host redirects relative, as Next.js does.
    const taken = new Set(sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
    let inner = `handle${name[0].toUpperCase()}${name.slice(1)}`;
    while (taken.has(inner)) inner = `${inner}_`;
    const requestBinding = requestName === 'request' ? 'request' : `request: ${requestName}`;
    edits.replaceRange(
        fn.getStart(),
        body.getStart(),
        `// The middleware as written for Next.js.\nconst ${inner}: MiddlewareFunction<Response> = async ({ ${requestBinding}, url }, next) => `
    );
    edits.insertAfter(
        body,
        `;

// Next.js sends a redirect that the middleware itself returns, to the same host, with a relative Location
// (\`/login\` rather than \`https://example.com/login\`). Responses from further down (\`next()\`) are left alone.
export const ${name}: MiddlewareFunction<Response> = async (args, next) => {
    let downstream: Response | undefined;
    const response = await ${inner}(args, async () => (downstream = await next()));
    return response instanceof Response && response !== downstream ? relativeRedirect(response, args.url) : response;
};

function relativeRedirect(response: Response, url: URL): Response {
    const location = response.headers.get('Location');
    if (!location || response.status < 300 || response.status >= 400) return response;
    const target = new URL(location, url);
    if (target.host !== url.host) return response;
    const headers = new Headers(response.headers);
    headers.set('Location', target.origin === url.origin ? target.href.slice(url.origin.length) : target.href);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}`
    );
    if (matchers) {
        const indent = body.getStatements()[0]?.getIndentationText() ?? '    ';
        edits.insert(body.getStart() + 1, `\n${indent}if (!MATCHER.some((pattern) => pattern.test(url.pathname))) return next();`);
        const patterns = matchers.map((matcher) => `new RegExp(${JSON.stringify(matcherToRegExpSource(matcher))})`);
        edits.insertBefore(
            fn,
            `// Paths this middleware applies to (was \`config.matcher\`).\nconst MATCHER = [${patterns.join(', ')}];\n\n`
        );
    }
    edits.apply();

    for (const decl of findImport(sourceFile, 'next/server')) decl.remove();
    for (const importName of imports) {
        addNamedImport(sourceFile, 'react-router', importName, { typeOnly: importName === 'MiddlewareFunction' });
    }
    // The file moves into the app directory: rebase its relative imports.
    for (const decl of sourceFile.getImportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        if (!specifier.startsWith('.')) continue;
        let rebased = path.relative(path.dirname(toFile), path.resolve(fromDir, specifier)).split(path.sep).join('/');
        if (!rebased.startsWith('.')) rebased = `./${rebased}`;
        decl.setModuleSpecifier(rebased);
    }
    return { name };
}
