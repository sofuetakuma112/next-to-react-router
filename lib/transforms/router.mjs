// next/router (useRouter, withRouter, NextRouter) → react-router hooks
//
//   router.push(x)      → navigate(x)
//   router.replace(x)   → navigate(x, { replace: true })
//   router.back()       → navigate(-1)
//   router.query        → useQuery()         … route params merged with the query string (same as Next)
//   router.pathname     → useRoutePattern()  … the pattern of the matched route ('/posts/:id')
//   router.asPath       → createPath(useLocation())
//   router.isReady      → true               … in React Router the URL is readable from the first render
import { Node, SyntaxKind } from 'ts-morph';
import { Edits, addNamedImport, enclosingFunction, findImport, pruneUnusedImports, unsupported } from '../util.mjs';
import { convertUrlExpression } from './simple.mjs';

// Placeholder for the generated navigation helper module; resolved per file when imports are written.
const NAVIGATION = Symbol('navigation');

const HOOKS = {
    navigate: { name: 'navigate', init: 'useNavigate()', module: 'react-router', importName: 'useNavigate' },
    location: { name: 'location', init: 'useLocation()', module: 'react-router', importName: 'useLocation' },
    query: { name: 'query', init: 'useQuery()', module: NAVIGATION, importName: 'useQuery' },
    pattern: { name: 'routePattern', init: 'useRoutePattern()', module: NAVIGATION, importName: 'useRoutePattern' },
};

function capitalize(text) {
    return text[0].toUpperCase() + text.slice(1);
}

/** Whether the same name is already declared or referenced inside the function (excluding the router-derived spots) */
function isNameTaken(fn, name, ignore) {
    return fn.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
        if (id.getText() !== name || ignore.has(id)) return false;
        const parent = id.getParent();
        // `x.name`, `{ name: … }`, and JSX attribute names are not variables
        if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return false;
        if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return false;
        if (Node.isJsxAttribute(parent)) return false;
        if (Node.isPropertySignature(parent)) return false;
        return true;
    });
}

export function transformRouterBinding(edits, binding, imports, context, sourceFile) {
    const navigationModule = () => context.moduleSpecifier(sourceFile, 'navigation');
    const { fn, name } = binding;
    const used = new Map(); // key → variable name
    const references = fn
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((id) => id.getText() === name && id !== binding.declarationName);

    // For `const query = router.query;`, reuse that variable name as the one that receives useQuery()
    let queryAlias = null;
    for (const id of references) {
        const access = id.getParent();
        if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== id || access.getName() !== 'query') continue;
        const declaration = access.getParent();
        if (
            Node.isVariableDeclaration(declaration) &&
            declaration.getInitializer() === access &&
            Node.isIdentifier(declaration.getNameNode())
        ) {
            queryAlias = { name: declaration.getName(), statement: declaration.getVariableStatementOrThrow(), access };
            break;
        }
    }

    const ignore = new Set(references);
    const varName = (key) => {
        if (used.has(key)) return used.get(key);
        let chosen = HOOKS[key].name;
        if (key === 'query' && queryAlias) chosen = queryAlias.name;
        else if (isNameTaken(fn, chosen, ignore)) chosen = `router${capitalize(chosen)}`;
        used.set(key, chosen);
        imports.push([HOOKS[key].module === NAVIGATION ? navigationModule() : HOOKS[key].module, HOOKS[key].importName]);
        return chosen;
    };

    const dependencyArrays = [];
    for (const id of references) {
        const parent = id.getParent();
        if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue; // x.router
        if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) continue;
        if (Node.isJsxAttribute(parent) || Node.isPropertySignature(parent)) continue;
        if (Node.isBindingElement(parent)) continue;

        if (Node.isArrayLiteralExpression(parent)) {
            // The router itself is listed in a hook dependency array
            dependencyArrays.push(id);
            continue;
        }
        if (!Node.isPropertyAccessExpression(parent) || parent.getExpression() !== id) {
            unsupported(id, 'Passing the router object itself around is not supported');
        }

        const member = parent.getName();
        const call = parent.getParent();
        const isCall = Node.isCallExpression(call) && call.getExpression() === parent;
        switch (member) {
            case 'push':
            case 'replace': {
                if (!isCall) unsupported(parent, `router.${member} can only be called`);
                const args = call.getArguments();
                if (args.length !== 1) unsupported(call, `router.${member}: only the first argument is supported`);
                edits.replace(parent, varName('navigate'));
                if (convertUrlExpression(edits, args[0])) {
                    imports.push([navigationModule(), 'searchOf']);
                }
                if (member === 'replace') edits.insertAfter(args[0], ', { replace: true }');
                break;
            }
            case 'back':
                if (!isCall) unsupported(parent, 'router.back can only be called');
                edits.replace(call, `${varName('navigate')}(-1)`);
                break;
            case 'reload':
                if (!isCall) unsupported(parent, 'router.reload can only be called');
                edits.replace(call, 'window.location.reload()');
                break;
            case 'query':
                if (queryAlias && queryAlias.access === parent) break;
                edits.replace(parent, varName('query'));
                break;
            case 'pathname':
            case 'route':
                edits.replace(parent, varName('pattern'));
                break;
            case 'asPath':
                imports.push(['react-router', 'createPath']);
                edits.replace(parent, `createPath(${varName('location')})`);
                break;
            case 'isReady':
                replaceIsReady(edits, parent);
                break;
            default:
                unsupported(parent, `router.${member} is not supported`);
        }
    }
    if (queryAlias) {
        varName('query');
        edits.removeStatement(queryAlias.statement);
    }
    for (const id of dependencyArrays) {
        edits.replace(id, [...used.values()].join(', ') || 'undefined');
    }

    const declarations = [...used.entries()].map(([key, chosen]) => `const ${chosen} = ${HOOKS[key].init};`);
    binding.writeDeclarations(declarations);
}

/**
 * router.isReady → true: React Router can read the URL from the first render, so the router is always ready.
 * The usual shapes are simplified rather than leaving a constant behind:
 *   router.isReady && x → x    if (!router.isReady) return; → (removed)    [router.isReady, a] → [a]    !router.isReady → false
 */
function replaceIsReady(edits, access) {
    const parent = access.getParent();
    if (Node.isArrayLiteralExpression(parent)) {
        // a hook's dependency list: a constant does not belong there
        const elements = parent.getElements();
        const index = elements.indexOf(access);
        if (index + 1 < elements.length) edits.replaceRange(access.getStart(), elements[index + 1].getStart(), '');
        else if (index > 0) edits.replaceRange(elements[index - 1].getEnd(), access.getEnd(), '');
        else edits.replace(access, '');
        return;
    }
    if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
        if (parent.getLeft() === access) edits.replaceRange(access.getStart(), parent.getRight().getStart(), '');
        else edits.replaceRange(parent.getLeft().getEnd(), access.getEnd(), '');
        return;
    }
    if (Node.isPrefixUnaryExpression(parent) && parent.getOperatorToken() === SyntaxKind.ExclamationToken) {
        const statement = parent.getParent();
        const container = statement?.getParent();
        if (
            Node.isIfStatement(statement) &&
            statement.getExpression() === parent &&
            !statement.getElseStatement() &&
            (Node.isBlock(container) || Node.isSourceFile(container))
        ) {
            // the condition is always false: the statement never runs
            edits.removeStatement(statement);
        } else {
            edits.replace(parent, 'false');
        }
        return;
    }
    edits.replace(access, 'true');
}

/** `const { query, pathname, push } = useRouter()` → one declaration per name, with the same local names. */
function transformDestructuredRouter(edits, fn, pattern, imports, context, sourceFile) {
    const navigation = () => context.moduleSpecifier(sourceFile, 'navigation');
    const lines = [];
    let navigateName = null;
    const navigate = () => {
        if (!navigateName) {
            const taken = fn.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === 'navigate');
            navigateName = taken ? 'routerNavigate' : 'navigate';
            imports.push(['react-router', 'useNavigate']);
            lines.unshift(`const ${navigateName} = useNavigate();`);
        }
        return navigateName;
    };
    for (const element of pattern.getElements()) {
        if (element.getDotDotDotToken()) unsupported(element, 'Rest elements are not supported when destructuring useRouter()');
        const member = element.getPropertyNameNode()?.getText() ?? element.getName();
        const local = element.getName();
        if (member === 'query') {
            imports.push([navigation(), 'useQuery']);
            lines.push(`const ${local} = useQuery();`);
        } else if (member === 'pathname' || member === 'route') {
            imports.push([navigation(), 'useRoutePattern']);
            lines.push(`const ${local} = useRoutePattern();`);
        } else if (member === 'asPath') {
            imports.push(['react-router', 'createPath'], ['react-router', 'useLocation']);
            lines.push(`const ${local} = createPath(useLocation());`);
        } else if (member === 'isReady') {
            lines.push(`const ${local} = true;`);
        } else if (['push', 'replace', 'back', 'reload'].includes(member)) {
            for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
                if (id.getText() !== local || id === element.getNameNode()) continue;
                const call = id.getParent();
                if (Node.isPropertyAccessExpression(call) && call.getNameNode() === id) continue;
                if (Node.isArrayLiteralExpression(call)) {
                    // hook dependency array
                    edits.replace(id, member === 'reload' ? 'undefined' : navigate());
                    continue;
                }
                if (!Node.isCallExpression(call) || call.getExpression() !== id) unsupported(id, `router.${member} can only be called`);
                const args = call.getArguments();
                if (member === 'back') edits.replace(call, `${navigate()}(-1)`);
                else if (member === 'reload') edits.replace(call, 'window.location.reload()');
                else {
                    if (args.length !== 1) unsupported(call, `router.${member}: only the first argument is supported`);
                    edits.replace(id, navigate());
                    if (convertUrlExpression(edits, args[0])) imports.push([navigation(), 'searchOf']);
                    if (member === 'replace') edits.insertAfter(args[0], ', { replace: true }');
                }
            }
        } else {
            unsupported(element, `router.${member} is not supported`);
        }
    }
    return lines;
}

export function transformRouter(sourceFile, context) {
    const decls = findImport(sourceFile, 'next/router');
    if (decls.length === 0) return false;

    const localNames = {};
    for (const decl of decls) {
        if (decl.getDefaultImport()) unsupported(decl, 'The default import of next/router (Router) is not supported');
        for (const named of decl.getNamedImports()) {
            localNames[named.getName()] = named.getAliasNode()?.getText() ?? named.getName();
        }
    }
    for (const name of Object.keys(localNames)) {
        if (!['useRouter', 'withRouter', 'NextRouter'].includes(name)) {
            unsupported(decls[0], `next/router: ${name} is not supported`);
        }
    }

    const edits = new Edits(sourceFile);
    const imports = [];
    const bindings = [];

    // (a) const router = useRouter();   /   const { query, push } = useRouter();
    if (localNames.useRouter) {
        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (call.getExpression().getText() !== localNames.useRouter) continue;
            const declaration = call.getParent();
            if (!Node.isVariableDeclaration(declaration)) {
                unsupported(call, 'useRouter() must be assigned: `const router = useRouter()` or `const { query } = useRouter()`');
            }
            const statement = declaration.getVariableStatementOrThrow();
            const indent = statement.getIndentationText();
            const fn = enclosingFunction(call) ?? unsupported(call, 'useRouter() is called outside a function');
            const nameNode = declaration.getNameNode();
            if (Node.isObjectBindingPattern(nameNode)) {
                const lines = transformDestructuredRouter(edits, fn, nameNode, imports, context, sourceFile);
                edits.replace(statement, lines.join(`\n${indent}`));
                continue;
            }
            bindings.push({
                fn,
                name: declaration.getName(),
                declarationName: nameNode,
                writeDeclarations: (lines) => {
                    if (lines.length === 0) edits.removeStatement(statement);
                    else edits.replace(statement, lines.join(`\n${indent}`));
                },
            });
        }
    }

    // (b) Components that receive router: NextRouter through props (the ones that were wrapped in withRouter)
    if (localNames.NextRouter) {
        const routerProps = new Set();
        for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
            if (reference.getTypeName().getText() !== localNames.NextRouter) continue;
            const member = reference.getParent();
            if (!Node.isPropertySignature(member)) unsupported(reference, 'This use of the NextRouter type is not supported');
            routerProps.add(member.getName());
            edits.removeStatement(member);
        }
        for (const fn of [
            ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
            ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
            ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
        ]) {
            const pattern = fn.getParameters()[0]?.getNameNode();
            if (!pattern || !Node.isObjectBindingPattern(pattern)) continue;
            const elements = pattern.getElements();
            const index = elements.findIndex(
                (element) => !element.getDotDotDotToken() && routerProps.has(element.getPropertyNameNode()?.getText() ?? element.getName())
            );
            if (index === -1) continue;
            const element = elements[index];
            const body = fn.getBody();
            if (!body || !Node.isBlock(body)) unsupported(fn, 'A function that receives router through props must have a block body');
            // Remove router from the destructuring. If only a rest element remains, as in `{ router, ...props }`, make it a plain parameter
            const others = elements.filter((other) => other !== element);
            if (others.length === 1 && others[0].getDotDotDotToken()) {
                edits.replace(pattern, others[0].getName());
            } else {
                const end = index + 1 < elements.length ? elements[index + 1].getStart() : element.getEnd();
                edits.replaceRange(element.getStart(), end, '');
            }
            const first = body.getStatements()[0];
            const indent = first ? first.getIndentationText() : '    ';
            bindings.push({
                fn,
                name: element.getName(),
                declarationName: element.getNameNode(),
                writeDeclarations: (lines) => {
                    if (lines.length > 0) edits.insert(body.getStart() + 1, `\n${indent}${lines.join(`\n${indent}`)}`);
                },
            });
        }
    }

    for (const binding of bindings) transformRouterBinding(edits, binding, imports, context, sourceFile);

    // withRouter(Component) → Component
    if (localNames.withRouter) {
        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (call.getExpression().getText() !== localNames.withRouter) continue;
            edits.replace(call, call.getArguments()[0].getText());
        }
    }

    // UrlObject from Node's url module (the type of router.push's argument) → react-router's To
    const urlObjectImport = findImport(sourceFile, 'url').find((decl) =>
        decl.getNamedImports().some((named) => named.getName() === 'UrlObject')
    );
    if (urlObjectImport) {
        for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
            if (reference.getTypeName().getText() === 'UrlObject') edits.replace(reference, 'To');
        }
        imports.push(['react-router', 'To', { typeOnly: true }]);
    }

    edits.apply();
    for (const decl of findImport(sourceFile, 'next/router')) decl.remove();
    pruneUnusedImports(sourceFile, 'url');
    for (const [moduleName, name, options] of imports) addNamedImport(sourceFile, moduleName, name, options);
    return true;
}
