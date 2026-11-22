// Whether an href may be a relative path (`about`, `./about`, `../about`).
//
// next/link and router.push resolved a relative path against the path of the current page, as a browser resolves a
// relative URL: `about` on /team is /about. React Router resolves it against the route the link is rendered in, so the
// same `to` leads to /team/about. Hrefs that may be relative are therefore resolved at runtime the way Next.js did
// (app/lib/link.tsx and useResolveHref in app/lib/navigation.ts). Everything that is known to be absolute keeps
// React Router's own Link and navigate().
import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';

/** Absolute paths, URLs with a scheme, and a query or hash on its own mean the same thing in Next.js and React Router. */
export function isRelativePath(value) {
    return value !== '' && !/^(?:\/|[a-z][a-z0-9+.-]*:|[?#])/i.test(value);
}

// How many declarations to follow (`routes.home` → `{ home: '/' }`, a function → its return values)
const MAX_DEPTH = 6;

function isFunctionLike(node) {
    return (
        Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node)
    );
}

function declarationOf(expression) {
    let symbol = expression.getSymbol();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    const declarations = symbol?.getDeclarations() ?? [];
    return declarations.length === 1 ? declarations[0] : null;
}

/** The value a name was declared with, when it cannot have changed since (a const variable or an object property). */
function initializerOf(declaration) {
    if (Node.isVariableDeclaration(declaration)) {
        const list = declaration.getParent();
        if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) return null;
        return declaration.getInitializer() ?? null;
    }
    if (Node.isPropertyAssignment(declaration)) return declaration.getInitializer() ?? null;
    return null;
}

/** The function a call runs: a declared function, or the callback of useMemo(() => …). */
function calledFunction(call) {
    const callee = call.getExpression();
    if (/^(?:React\.)?useMemo$/.test(callee.getText())) return call.getArguments()[0] ?? null;
    const declaration = declarationOf(callee);
    if (!declaration) return null;
    return isFunctionLike(declaration) ? declaration : initializerOf(declaration);
}

/** The expressions a call can return, or null when the function cannot be found. */
function returnedExpressions(call) {
    const fn = calledFunction(call);
    if (!fn || !isFunctionLike(fn)) return null;
    const body = fn.getBody();
    if (!body) return null;
    if (!Node.isBlock(body)) return [body];
    return body
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => statement.getFirstAncestor(isFunctionLike) === fn)
        .map((statement) => statement.getExpression());
}

/** true / false when the type alone answers the question (string literal types), otherwise null. */
function fromType(type) {
    const parts = (type.isUnion() ? type.getUnionTypes() : [type]).filter((part) => !part.isUndefined() && !part.isNull());
    if (parts.length === 0 || !parts.every((part) => part.isStringLiteral())) return null;
    return parts.some((part) => isRelativePath(part.getLiteralValue()));
}

/**
 * false when every value `expression` can take is known not to be a relative path, true when it may be one.
 * Accepts the forms an href takes: strings, templates, URL objects ({ pathname, query }), and names or calls that
 * lead to them.
 */
export function mayBeRelativeHref(expression, depth = 0) {
    if (!expression || depth > MAX_DEPTH) return true;
    const next = (node) => mayBeRelativeHref(node, depth + 1);

    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
        return isRelativePath(expression.getLiteralValue());
    }
    if (Node.isTemplateExpression(expression)) {
        const head = expression.getHead().getLiteralText();
        return head === '' ? next(expression.getTemplateSpans()[0].getExpression()) : isRelativePath(head);
    }
    if (
        Node.isParenthesizedExpression(expression) ||
        Node.isAsExpression(expression) ||
        Node.isSatisfiesExpression(expression) ||
        Node.isNonNullExpression(expression) ||
        Node.isTypeAssertion(expression)
    ) {
        return next(expression.getExpression());
    }
    if (Node.isConditionalExpression(expression)) {
        return next(expression.getWhenTrue()) || next(expression.getWhenFalse());
    }
    if (Node.isBinaryExpression(expression)) {
        const operator = expression.getOperatorToken().getKind();
        if (operator === SyntaxKind.BarBarToken || operator === SyntaxKind.QuestionQuestionToken) {
            return next(expression.getLeft()) || next(expression.getRight());
        }
        // `cond && href`: the left side only ever contributes a falsy value
        if (operator === SyntaxKind.AmpersandAmpersandToken) return next(expression.getRight());
        // `'/posts/' + id`: the start decides
        if (operator === SyntaxKind.PlusToken) return next(expression.getLeft());
    }
    if (Node.isObjectLiteralExpression(expression)) {
        const pathname = expression.getProperty('pathname');
        if (!pathname) return false; // only a query or hash: stays on the current path in both
        if (Node.isPropertyAssignment(pathname)) return next(pathname.getInitializer());
        if (Node.isShorthandPropertyAssignment(pathname)) return fromType(pathname.getType()) ?? true;
        return true;
    }

    const known = fromType(expression.getType());
    if (known !== null) return known;

    if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
        const declaration = declarationOf(expression);
        const initializer = declaration && initializerOf(declaration);
        if (initializer) return next(initializer);
    }
    if (Node.isCallExpression(expression)) {
        const returned = returnedExpressions(expression);
        if (returned && returned.length > 0) return returned.some((node) => next(node));
    }
    return true;
}

/**
 * Next.js URL objects ({ pathname, query }) that `expression` can evaluate to but that are written elsewhere: returned
 * by a function or assigned to a constant, as in `<Link href={chatRoute()}>`. React Router reads only pathname, search
 * and hash, so their `query` would be dropped. Follows the same paths as mayBeRelativeHref.
 */
export function reachableUrlObjects(expression, depth = 0, found = new Set()) {
    if (!expression || depth > MAX_DEPTH) return found;
    const next = (node) => reachableUrlObjects(node, depth + 1, found);
    if (Node.isObjectLiteralExpression(expression)) {
        if (expression.getProperty('query')) found.add(expression);
    } else if (
        Node.isParenthesizedExpression(expression) ||
        Node.isAsExpression(expression) ||
        Node.isSatisfiesExpression(expression) ||
        Node.isNonNullExpression(expression) ||
        Node.isTypeAssertion(expression)
    ) {
        next(expression.getExpression());
    } else if (Node.isConditionalExpression(expression)) {
        next(expression.getWhenTrue());
        next(expression.getWhenFalse());
    } else if (Node.isBinaryExpression(expression)) {
        const operator = expression.getOperatorToken().getKind();
        if (operator === SyntaxKind.BarBarToken || operator === SyntaxKind.QuestionQuestionToken) next(expression.getLeft());
        if ([SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken, SyntaxKind.AmpersandAmpersandToken].includes(operator)) {
            next(expression.getRight());
        }
    } else if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
        const declaration = declarationOf(expression);
        next(declaration && initializerOf(declaration));
    } else if (Node.isCallExpression(expression)) {
        for (const returned of returnedExpressions(expression) ?? []) next(returned);
    }
    return found;
}
