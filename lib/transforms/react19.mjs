// Rewrites for types that changed between React 18 and 19 (React Router 8 requires React 19)
import { Node, SyntaxKind } from 'ts-morph';
import { Edits, addNamedImport, jsxAttribute } from '../util.mjs';

/**
 * The global JSX namespace (JSX.Element etc.) was removed in @types/react 19, so import it from react.
 * When it is used inside `declare module '…' { … }`, the import is added inside that block.
 */
export function transformGlobalJsxNamespace(sourceFile) {
    const hasJsxBinding = (scope) =>
        scope.getImportDeclarations?.().some((decl) => decl.getNamedImports().some((named) => named.getName() === 'JSX'));
    const targets = new Set();
    for (const qualified of sourceFile.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
        const left = qualified.getLeft();
        if (!Node.isIdentifier(left) || left.getText() !== 'JSX') continue;
        const moduleBlock = qualified.getFirstAncestorByKind(SyntaxKind.ModuleDeclaration);
        targets.add(moduleBlock ?? sourceFile);
    }
    let changed = false;
    for (const scope of targets) {
        if (hasJsxBinding(scope)) continue;
        if (scope === sourceFile) {
            addNamedImport(sourceFile, 'react', 'JSX', { typeOnly: true });
        } else {
            scope.insertStatements(0, "import type { JSX } from 'react';");
        }
        changed = true;
    }
    return changed;
}

/** useRef<T>() now requires an argument → useRef<T>(undefined) */
export function transformUseRefWithoutArgument(sourceFile) {
    const edits = new Edits(sourceFile);
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression().getText();
        if ((callee === 'useRef' || callee === 'React.useRef') && call.getArguments().length === 0) {
            edits.insert(call.getEnd() - 1, 'undefined');
        }
    }
    return edits.apply();
}

/**
 * useRef<T>(null) now returns RefObject<T | null>.
 * Make the types on the receiving side of a ref (RefObject<T>) include null as well.
 */
export function transformRefObjectTypes(sourceFile) {
    const edits = new Edits(sourceFile);
    for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
        const name = reference.getTypeName().getText();
        if (name !== 'RefObject' && name !== 'React.RefObject') continue;
        const args = reference.getTypeArguments();
        if (args.length !== 1 || /\bnull\b/.test(args[0].getText())) continue;
        const needsParens = Node.isFunctionTypeNode(args[0]) || Node.isConditionalTypeNode(args[0]);
        edits.replace(args[0], needsParens ? `(${args[0].getText()}) | null` : `${args[0].getText()} | null`);
    }
    return edits.apply();
}

/**
 * In React 19, a value returned from a ref callback is treated as a cleanup function (and is also a type error).
 * Callbacks that return an expression directly, like `ref={(el) => (refs.current[i] = el)}`, are rewritten to return nothing.
 */
export function transformRefCallbackReturns(sourceFile) {
    const edits = new Edits(sourceFile);
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
        if (attribute.getNameNode().getText() !== 'ref') continue;
        const initializer = attribute.getInitializer();
        const callback = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : null;
        if (!callback || !Node.isArrowFunction(callback)) continue;
        const body = callback.getBody();
        if (Node.isBlock(body)) continue;
        let expression = body;
        while (Node.isParenthesizedExpression(expression)) expression = expression.getExpression();
        if (Node.isVoidExpression(expression)) continue;
        const isAssignment = Node.isBinaryExpression(expression) && expression.getOperatorToken().getText() === '=';
        edits.replace(body, isAssignment ? `{\n${expression.getText()};\n}` : `void ${body.getText()}`);
    }
    return edits.apply();
}

const INPUT_ELEMENTS = { input: 'HTMLInputElement', textarea: 'HTMLTextAreaElement', select: 'HTMLSelectElement' };

/**
 * onInput is now typed as InputEventHandler, so a function that takes a ChangeEvent (one that reads e.target.value)
 * can no longer be passed as is. Runtime behavior is unchanged, so only the type is adjusted.
 */
export function transformOnInputHandlers(sourceFile) {
    const edits = new Edits(sourceFile);
    for (const element of [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ]) {
        const elementType = INPUT_ELEMENTS[element.getTagNameNode().getText()];
        if (!elementType) continue;
        const initializer = jsxAttribute(element, 'onInput')?.getInitializer();
        const handler = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : null;
        // For a function written inline, the parameter type is inferred from onInput
        if (!handler || Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) continue;
        if (Node.isAsExpression(handler)) continue;
        edits.replace(handler, `${handler.getText()} as unknown as InputEventHandler<${elementType}>`);
    }
    if (!edits.apply()) return false;
    addNamedImport(sourceFile, 'react', 'InputEventHandler', { typeOnly: true });
    return true;
}

/**
 * Changes `fetchpriority`, written in lowercase under React 18 so it passed straight through to the DOM, to `fetchPriority`, which React 19 supports.
 * The preceding `// @ts-ignore` that silenced the type error is no longer needed either, so it is removed.
 */
export function transformFetchPriorityAttribute(sourceFile) {
    const edits = new Edits(sourceFile);
    const full = sourceFile.getFullText();
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
        const name = attribute.getNameNode();
        if (name.getText() !== 'fetchpriority') continue;
        edits.replace(name, 'fetchPriority');
        const leading = full.slice(attribute.getFullStart(), attribute.getStart());
        const comment = /[ \t]*\/\/\s*@ts-(ignore|expect-error)[^\n]*\n/.exec(leading);
        if (comment) {
            const start = attribute.getFullStart() + comment.index;
            edits.replaceRange(start, start + comment[0].length, '');
        }
    }
    return edits.apply();
}
