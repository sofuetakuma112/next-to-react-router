// getServerSideProps / getStaticProps → loader
//
//   return { props: X }                                  → return X            (data(X, init) when there are headers or a status)
//   return { redirect: { destination, statusCode } }     → return redirect(destination, statusCode)
//   return { notFound: true }                            → throw data(null, { status: 404 })
//   context.query                                        → parseQuery(context.url.searchParams)
//   context.res.setHeader(k, v) / context.res.statusCode → moved into the init of the data() / redirect() that function returns
//   function with only res.setHeader(…); res.end(body)   → rewritten to return new Response(body, { headers })
//
// The same rules apply not only to page files but also to helper functions called from pages (utils/ etc.).
import { Node, SyntaxKind } from 'ts-morph';
import { Edits, addNamedImport, enclosingFunction, pruneUnusedImports, unsupported } from '../util.mjs';

const CONTEXT_TYPES = new Set(['GetServerSidePropsContext', 'GetStaticPropsContext']);
const FUNCTION_TYPES = new Set(['GetServerSideProps', 'GetStaticProps']);
const RESULT_TYPES = new Set(['GetServerSidePropsResult', 'GetStaticPropsResult']);
const EXPORT_NAMES = new Set(['getServerSideProps', 'getStaticProps']);
const RESPONSE_TYPE = 'ServerResponse';

function isFunctionLike(node) {
    return node && (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node));
}

function typeName(typeNode) {
    return typeNode && Node.isTypeReference(typeNode) ? typeNode.getTypeName().getText() : null;
}

function resultType(props) {
    return `${props} | ReturnType<typeof data<${props}>> | Response`;
}

/**
 * Parses `res.setHeader(…)`, `res.statusCode = …`, and `res.end(…)`.
 * @param isRes function that tells whether an expression refers to the ServerResponse
 */
function parseResponseEffect(statement, isRes) {
    if (!Node.isExpressionStatement(statement)) return null;
    const expression = statement.getExpression();
    if (Node.isCallExpression(expression)) {
        const callee = expression.getExpression();
        if (!Node.isPropertyAccessExpression(callee) || !isRes(callee.getExpression())) return null;
        const args = expression.getArguments().map((arg) => arg.getText());
        if (callee.getName() === 'setHeader' && args.length === 2) return { header: [args[0], args[1]] };
        if (['end', 'write'].includes(callee.getName()) && args.length <= 1) return { body: args[0] ?? 'null' };
        return null;
    }
    if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getText() === '=') {
        const left = expression.getLeft();
        if (Node.isPropertyAccessExpression(left) && left.getName() === 'statusCode' && isRes(left.getExpression())) {
            return { status: expression.getRight().getText() };
        }
    }
    return null;
}

function mergeEffects(target, effect) {
    if (effect.header) target.headers.push(effect.header);
    if (effect.headers) target.headers.push(...effect.headers);
    if (effect.status) target.status = effect.status;
}

function headersText(headers) {
    return `{ ${headers.map(([key, value]) => `${key}: ${value}`).join(', ')} }`;
}

function initText({ status, headers }) {
    const parts = [];
    if (status) parts.push(`status: ${status}`);
    if (headers.length > 0) parts.push(`headers: ${headersText(headers)}`);
    return parts.length > 0 ? `{ ${parts.join(', ')} }` : null;
}

/**
 * Collects, across the whole project, the functions that only write to a ServerResponse (e.g. writeXml(res, body)).
 * They are rewritten to return a Response, and their call sites become `return writeXml(body)`.
 * @returns {Map<string, { resIndex: number }>} function name → index of the res parameter
 */
export function collectResponseFactories(project) {
    const factories = new Map();
    for (const sourceFile of project.getSourceFiles()) {
        for (const fn of sourceFile.getFunctions()) {
            const resIndex = fn.getParameters().findIndex((param) => typeName(param.getTypeNode()) === RESPONSE_TYPE);
            if (resIndex === -1 || !fn.getName()) continue;
            const resName = fn.getParameters()[resIndex].getName();
            const isRes = (node) => node.getText() === resName;
            const effects = fn.getStatements().map((statement) => parseResponseEffect(statement, isRes));
            if (effects.some((effect) => !effect) || !effects.some((effect) => effect.body)) {
                unsupported(
                    fn,
                    'A function that takes a ServerResponse is only supported when it consists of setHeader and end calls alone'
                );
            }
            factories.set(fn.getName(), { resIndex });
        }
    }
    return factories;
}

function rewriteResponseFactory(edits, fn, resIndex) {
    const params = fn.getParameters();
    const resName = params[resIndex].getName();
    const isRes = (node) => node.getText() === resName;
    const init = { status: null, headers: [] };
    let body = 'null';
    for (const statement of fn.getStatements()) {
        const effect = parseResponseEffect(statement, isRes);
        if (effect.body) body = effect.body;
        else mergeEffects(init, effect);
    }
    const end = resIndex + 1 < params.length ? params[resIndex + 1].getStart() : params[resIndex].getEnd();
    edits.replaceRange(params[resIndex].getStart(), end, '');
    const returnType = fn.getReturnTypeNode();
    if (returnType) edits.replace(returnType, 'Response');
    else edits.insertBefore(fn.getBodyOrThrow(), ': Response ');
    const indent = fn.getStatements()[0]?.getIndentationText() ?? '    ';
    edits.replace(fn.getBodyOrThrow(), `{\n${indent}return new Response(${body}, ${initText(init) ?? '{}'});\n${fn.getIndentationText()}}`);
}

/**
 * @returns {{ changed: boolean, loader: 'getServerSideProps' | 'getStaticProps' | null }}
 *   loader is the kind of data function this file exported (now renamed to loader)
 */
export function transformDataFunctions(sourceFile, { responseFactories, context }) {
    const text = sourceFile.getFullText();
    const mentionsNext = /GetServerSideProps|GetStaticProps|getServerSideProps|getStaticProps/.test(text);
    const localFactories = sourceFile.getFunctions().filter((fn) => responseFactories.has(fn.getName() ?? ''));
    if (!mentionsNext && localFactories.length === 0) return { changed: false, loader: null };

    const edits = new Edits(sourceFile);
    const imports = new Set();
    const contextFunctions = new Map(); // function node → { annotate: boolean }
    const addContextFunction = (fn, annotate) => {
        if (!isFunctionLike(fn)) return;
        contextFunctions.set(fn, { annotate: annotate && (contextFunctions.get(fn)?.annotate ?? true) });
    };

    // --- Replace types ------------------------------------------------------------------------
    const functionAliases = new Set();
    for (const alias of sourceFile.getTypeAliases()) {
        if (FUNCTION_TYPES.has(typeName(alias.getTypeNode()) ?? '')) functionAliases.add(alias.getName());
    }
    const isFunctionType = (typeNode) => {
        const name = typeName(typeNode);
        return name !== null && (FUNCTION_TYPES.has(name) || functionAliases.has(name));
    };

    for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
        const name = reference.getTypeName().getText();
        const [propsArg] = reference.getTypeArguments();
        if (CONTEXT_TYPES.has(name)) {
            edits.replace(reference, 'LoaderFunctionArgs');
            imports.add('LoaderFunctionArgs');
        } else if (RESULT_TYPES.has(name)) {
            edits.replace(reference, resultType(propsArg?.getText() ?? '{ [key: string]: any }'));
            imports.add('data');
        } else if (FUNCTION_TYPES.has(name)) {
            const parent = reference.getParent();
            if (Node.isVariableDeclaration(parent) && parent.getTypeNode() === reference) {
                // Drop the variable's type annotation so the return type is inferred (typegen derives the page props from the loader's return value)
                edits.replaceRange(parent.getNameNode().getEnd(), reference.getEnd(), '');
                addContextFunction(parent.getInitializer(), true);
            } else {
                const props = propsArg?.getText() ?? '{ [key: string]: any }';
                edits.replace(reference, `(_context: LoaderFunctionArgs) => Promise<${resultType(props)}>`);
                imports.add('LoaderFunctionArgs');
                imports.add('data');
            }
        }
    }

    // --- Collect the functions that act as loaders --------------------------------------------
    const allFunctions = [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ];
    for (const fn of allFunctions) {
        // The first parameter has a context type
        if (CONTEXT_TYPES.has(typeName(fn.getParameters()[0]?.getTypeNode()) ?? '')) addContextFunction(fn, false);
        // The variable's type is Handler (= an alias of GetServerSideProps)
        const declaration = fn.getParent();
        if (Node.isVariableDeclaration(declaration) && declaration.getInitializer() === fn) {
            const typeNode = declaration.getTypeNode();
            if (typeNode && functionAliases.has(typeName(typeNode) ?? '')) addContextFunction(fn, false);
            if (!typeNode && EXPORT_NAMES.has(declaration.getName())) addContextFunction(fn, true);
        }
        if (Node.isFunctionDeclaration(fn) && EXPORT_NAMES.has(fn.getName() ?? '')) addContextFunction(fn, true);
        // A function returned by a function (factory) that returns GetServerSideProps
        if (isFunctionType(fn.getReturnTypeNode())) {
            for (const statement of fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
                if (enclosingFunction(statement) === fn) addContextFunction(statement.getExpression(), false);
            }
            const body = fn.getBody();
            if (body && !Node.isBlock(body)) addContextFunction(body, false);
        }
    }

    // --- Helpers that only write to context.res (e.g. noCache(context)) ----------------
    const effectHelpers = new Map(); // function name → effects
    for (const [fn] of contextFunctions) {
        if (!Node.isFunctionDeclaration(fn) || !fn.getName() || fn.isExported()) continue;
        const param = fn.getParameters()[0];
        if (!param || !Node.isIdentifier(param.getNameNode())) continue;
        const isRes = (node) => node.getText() === `${param.getName()}.res`;
        const statements = fn.getStatements();
        const parsed = statements.map((statement) => parseResponseEffect(statement, isRes));
        if (statements.length === 0 || parsed.some((effect) => !effect || effect.body)) continue;
        const effects = { status: null, headers: [] };
        parsed.forEach((effect) => mergeEffects(effects, effect));
        effectHelpers.set(fn.getName(), effects);
        contextFunctions.delete(fn);
        edits.removeStatement(fn);
    }

    // --- Rewrite the bodies of the functions that act as loaders ------------------------------
    for (const [fn, { annotate }] of contextFunctions) {
        const param = fn.getParameters()[0];
        const body = fn.getBody();
        const statements = body && Node.isBlock(body) ? body.getStatements() : [];
        let contextName = null;
        let resName = null;

        if (param && Node.isIdentifier(param.getNameNode())) {
            contextName = param.getName();
            if (annotate && !param.getTypeNode()) {
                edits.insertAfter(param.getNameNode(), ': LoaderFunctionArgs');
                imports.add('LoaderFunctionArgs');
            }
        } else if (param && Node.isObjectBindingPattern(param.getNameNode())) {
            const elements = param.getNameNode().getElements();
            const kept = [];
            for (const element of elements) {
                const name = element.getPropertyNameNode()?.getText() ?? element.getName();
                if (name === 'res') {
                    resName = element.getName();
                } else if (name === 'query') {
                    if (!body || !Node.isBlock(body)) unsupported(fn, 'A function that destructures { query } must have a block body');
                    kept.push('url');
                    const indent = statements[0]?.getIndentationText() ?? '    ';
                    edits.insert(body.getStart() + 1, `\n${indent}const ${element.getName()} = parseQuery(url.searchParams);`);
                    imports.add('parseQuery');
                } else if (name === 'params') {
                    kept.push(element.getText());
                } else {
                    unsupported(element, `context.${name} is not supported`);
                }
            }
            if (kept.length === 0) {
                edits.replace(param, '');
            } else {
                edits.replace(param.getNameNode(), `{ ${[...new Set(kept)].join(', ')} }`);
                if (annotate && !param.getTypeNode()) {
                    edits.insertAfter(param.getNameNode(), ': LoaderFunctionArgs');
                    imports.add('LoaderFunctionArgs');
                }
            }
        }

        const isRes = (node) => {
            const nodeText = node.getText();
            return (resName !== null && nodeText === resName) || (contextName !== null && nodeText === `${contextName}.res`);
        };

        // Writes to the response at the top level of the function
        const effects = { status: null, headers: [] };
        const consumed = new Set();
        let rawBody = null;
        for (const statement of statements) {
            const direct = parseResponseEffect(statement, isRes);
            if (direct) {
                // `res.end(body)` (or `res.write(body)`): the function answers with a raw body instead of a page
                if (direct.body) rawBody = direct.body === 'null' ? rawBody : direct.body;
                else mergeEffects(effects, direct);
                consumed.add(statement);
                edits.removeStatement(statement);
                continue;
            }
            if (!Node.isExpressionStatement(statement)) continue;
            const call = statement.getExpression();
            if (!Node.isCallExpression(call)) continue;
            const helper = effectHelpers.get(call.getExpression().getText());
            if (helper && call.getArguments()[0]?.getText() === contextName) {
                mergeEffects(effects, helper);
                consumed.add(statement);
                edits.removeStatement(statement);
            }
        }
        const init = initText(effects);

        // Rewrite the returns
        const returned = fn
            .getDescendantsOfKind(SyntaxKind.ReturnStatement)
            .filter((statement) => enclosingFunction(statement) === fn)
            .map((statement) => ({ statement, expression: statement.getExpression() }));
        if (body && !Node.isBlock(body)) returned.push({ statement: null, expression: body });

        for (const { statement, expression: raw } of returned) {
            let expression = raw;
            while (expression && Node.isParenthesizedExpression(expression)) expression = expression.getExpression();
            if (!expression || !Node.isObjectLiteralExpression(expression)) continue;
            const property = (name) => {
                const found = expression.getProperty(name);
                return found && Node.isPropertyAssignment(found) ? found.getInitializerOrThrow() : null;
            };
            const props = property('props');
            const redirectTo = property('redirect');
            const notFound = property('notFound');

            if (props) {
                // If the preceding statement calls a Response-building function such as `writeXml(context.res, …)`, return that Response
                const previous = statement?.getPreviousSibling();
                const call = previous && Node.isExpressionStatement(previous) ? previous.getExpression() : null;
                const factory = call && Node.isCallExpression(call) ? responseFactories.get(call.getExpression().getText()) : null;
                if (factory) {
                    const args = call.getArguments();
                    const resArg = args[factory.resIndex];
                    if (!resArg || !isRes(resArg)) unsupported(call, 'A ServerResponse other than context.res is not supported');
                    const end = factory.resIndex + 1 < args.length ? args[factory.resIndex + 1].getStart() : resArg.getEnd();
                    edits.replaceRange(resArg.getStart(), end, '');
                    edits.insertBefore(previous, 'return ');
                    edits.removeStatement(statement);
                    consumed.add(previous);
                    continue;
                }
                if (rawBody !== null) {
                    edits.replace(expression, `new Response(${rawBody}, ${init ?? '{}'})`);
                } else if (init) {
                    imports.add('data');
                    edits.replaceRange(expression.getStart(), props.getStart(), 'data(');
                    edits.replaceRange(props.getEnd(), expression.getEnd(), `, ${init})`);
                } else {
                    edits.replaceRange(expression.getStart(), props.getStart(), '');
                    edits.replaceRange(props.getEnd(), expression.getEnd(), '');
                }
            } else if (redirectTo) {
                if (!Node.isObjectLiteralExpression(redirectTo)) unsupported(redirectTo, 'redirect must be an object literal');
                const field = (name) => {
                    const found = redirectTo.getProperty(name);
                    if (found && Node.isShorthandPropertyAssignment(found)) return found.getNameNode();
                    return found && Node.isPropertyAssignment(found) ? found.getInitializerOrThrow() : null;
                };
                const destination = field('destination') ?? unsupported(redirectTo, 'redirect.destination is missing');
                const permanent = field('permanent')?.getText();
                const status =
                    field('statusCode')?.getText() ??
                    (permanent === 'true' ? '308' : permanent === 'false' ? '307' : null) ??
                    unsupported(redirectTo, 'redirect needs a statusCode or permanent (true / false)');
                imports.add('redirect');
                const redirectInit = init ? initText({ status, headers: effects.headers }) : status;
                edits.replaceRange(expression.getStart(), destination.getStart(), 'redirect(');
                edits.replaceRange(destination.getEnd(), expression.getEnd(), `, ${redirectInit})`);
            } else if (notFound) {
                if (!statement) unsupported(expression, 'notFound is only supported in a return statement');
                imports.add('data');
                edits.replace(statement, 'throw data(null, { status: 404 });');
            }
        }

        // context.query / context.resolvedUrl / unsupported context.res and context.req
        if (contextName) {
            const accesses = fn
                .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                .filter((access) => Node.isIdentifier(access.getExpression()) && access.getExpression().getText() === contextName)
                .filter((access) => !access.getFirstAncestor((ancestor) => consumed.has(ancestor)));
            // Read more than once, the query goes into a variable (so type narrowing on it keeps working).
            const queryReads = accesses.filter((access) => access.getName() === 'query');
            let queryText = `parseQuery(${contextName}.url.searchParams)`;
            if (queryReads.length > 1 && body && Node.isBlock(body)) {
                const taken = fn
                    .getDescendantsOfKind(SyntaxKind.Identifier)
                    .some((id) => id.getText() === 'query' && !Node.isPropertyAccessExpression(id.getParent()));
                const variable = taken ? 'requestQuery' : 'query';
                const indent = statements[0]?.getIndentationText() ?? '    ';
                edits.insert(body.getStart() + 1, `\n${indent}const ${variable} = ${queryText};`);
                queryText = variable;
            }
            for (const access of accesses) {
                const name = access.getName();
                if (name === 'query') {
                    edits.replace(access, queryText);
                    imports.add('parseQuery');
                } else if (name === 'resolvedUrl') {
                    edits.replace(access, `(${contextName}.url.pathname + ${contextName}.url.search)`);
                } else if (['res', 'req', 'locale', 'locales', 'defaultLocale', 'preview', 'previewData'].includes(name)) {
                    unsupported(access, `context.${name} is not supported here`);
                }
            }
        }
        if (resName) {
            for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
                if (id.getText() !== resName || Node.isBindingElement(id.getParent())) continue;
                if (!id.getFirstAncestor((ancestor) => consumed.has(ancestor))) {
                    unsupported(id, 'This use of res is not supported');
                }
            }
        }
    }

    // --- Functions that only write to a ServerResponse → functions returning a Response -------
    for (const fn of localFactories) rewriteResponseFactory(edits, fn, responseFactories.get(fn.getName()).resIndex);

    // --- Rename the export to loader ----------------------------------------------------------
    let loader = null;
    for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
        if (!EXPORT_NAMES.has(name)) continue;
        if (loader) unsupported(declarations[0], 'Both getServerSideProps and getStaticProps are present');
        const [declaration] = declarations;
        // A no-op getStaticProps (one that only returns props: {}) is removed instead of becoming a loader
        const fn = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
        if (
            name === 'getStaticProps' &&
            isFunctionLike(fn) &&
            /^\{\s*return\s*\{\s*props:\s*\{\s*\},?\s*\};?\s*\}$/.test(fn.getBody()?.getText() ?? '')
        ) {
            edits.removeStatement(Node.isVariableDeclaration(declaration) ? declaration.getVariableStatementOrThrow() : declaration);
            continue;
        }
        loader = name;
        edits.replace(declaration.getNameNode(), 'loader');
    }

    edits.apply();

    // Functions that no longer use context once the writes to res are removed get the parameter renamed to `_context` (to satisfy unused-parameter lint rules)
    for (const fn of [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ]) {
        const param = fn.getParameters()[0];
        if (!param || typeName(param.getTypeNode()) !== 'LoaderFunctionArgs') continue;
        const nameNode = param.getNameNode();
        if (!Node.isIdentifier(nameNode) || nameNode.getText().startsWith('_')) continue;
        const name = nameNode.getText();
        const used = fn.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === name && id !== nameNode);
        if (!used) nameNode.replaceWithText(`_${name}`);
    }

    pruneUnusedImports(sourceFile, 'next');
    pruneUnusedImports(sourceFile, 'http');
    pruneUnusedImports(sourceFile, 'node:http');
    const stillNeeded = (name) => sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === name);
    for (const name of imports) {
        if (!stillNeeded(name)) continue;
        if (name === 'parseQuery') addNamedImport(sourceFile, context.moduleSpecifier(sourceFile, 'navigation'), name);
        else addNamedImport(sourceFile, 'react-router', name, { typeOnly: name === 'LoaderFunctionArgs' });
    }
    return { changed: true, loader };
}
