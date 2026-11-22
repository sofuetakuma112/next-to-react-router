// Small helpers shared across the codemod (batched text edits, import manipulation, logging)
import { Node, SyntaxKind } from 'ts-morph';

export class CodemodError extends Error {}

/** Stops with the source location when code that cannot be converted is found */
export function unsupported(node, message) {
    const sf = node.getSourceFile();
    const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
    throw new CodemodError(`${sf.getFilePath()}:${line}:${column} ${message}\n    ${node.getText().split('\n')[0]}`);
}

/**
 * Collects the edits for one file and applies them all at the end.
 * Manipulating the AST directly invalidates nodes, so edits are position-based text edits instead.
 */
export class Edits {
    constructor(sourceFile) {
        this.sourceFile = sourceFile;
        this.list = [];
    }

    get size() {
        return this.list.length;
    }

    replaceRange(start, end, text) {
        this.list.push({ start, end, text, seq: this.list.length });
    }

    replace(node, text) {
        this.replaceRange(node.getStart(), node.getEnd(), text);
    }

    insert(pos, text) {
        this.replaceRange(pos, pos, text);
    }

    insertBefore(node, text) {
        this.insert(node.getStart(), text);
    }

    insertAfter(node, text) {
        this.insert(node.getEnd(), text);
    }

    /** Removes a statement together with its line (leading comments are kept). Edits queued inside the statement are dropped */
    removeStatement(node) {
        this.list = this.list.filter((edit) => edit.start < node.getStart() || edit.end > node.getEnd());
        const full = this.sourceFile.getFullText();
        let start = node.getStart();
        while (start > 0 && (full[start - 1] === ' ' || full[start - 1] === '\t')) start--;
        let end = node.getEnd();
        while (end < full.length && (full[end] === ' ' || full[end] === '\t')) end++;
        if (full[end] === '\r') end++;
        if (full[end] === '\n') end++;
        this.replaceRange(start, end, '');
    }

    apply() {
        if (this.list.length === 0) return false;
        const sorted = [...this.list].sort((a, b) => a.start - b.start || a.end - b.end || a.seq - b.seq);
        const full = this.sourceFile.getFullText();
        let out = '';
        let cursor = 0;
        for (const edit of sorted) {
            if (edit.start < cursor) {
                throw new CodemodError(
                    `${this.sourceFile.getFilePath()}: overlapping edit ranges (${edit.start}-${edit.end}: ${JSON.stringify(edit.text)})`
                );
            }
            out += full.slice(cursor, edit.start) + edit.text;
            cursor = edit.end;
        }
        out += full.slice(cursor);
        this.sourceFile.replaceWithText(out);
        this.list = [];
        return true;
    }
}

export function findImport(sourceFile, moduleName) {
    return sourceFile.getImportDeclarations().filter((decl) => decl.getModuleSpecifierValue() === moduleName);
}

/** Adds `import { name } from module` (to an existing import of the same module, if there is one) */
export function addNamedImport(sourceFile, moduleName, name, { typeOnly = false } = {}) {
    const decls = findImport(sourceFile, moduleName).filter((decl) => !decl.getNamespaceImport());
    for (const decl of decls) {
        const existing = decl.getNamedImports().find((named) => named.getName() === name);
        if (existing) {
            // If the name is needed as a value but is imported type-only, turn it into a value import
            if (!typeOnly && (decl.isTypeOnly() || existing.isTypeOnly())) {
                if (decl.isTypeOnly()) continue;
                existing.setIsTypeOnly(false);
            }
            return;
        }
    }
    const target = decls.find((decl) => decl.isTypeOnly() === typeOnly) ?? (typeOnly ? decls[0] : undefined);
    if (target) {
        target.addNamedImport(typeOnly && !target.isTypeOnly() ? { name, isTypeOnly: true } : { name });
        return;
    }
    sourceFile.addImportDeclaration({ moduleSpecifier: moduleName, namedImports: [name], isTypeOnly: typeOnly });
}

/** Removes a named import that is no longer used (and the whole import statement once it is empty) */
export function removeNamedImport(sourceFile, moduleName, name) {
    for (const decl of findImport(sourceFile, moduleName)) {
        const matched = decl.getNamedImports().filter((named) => named.getName() === name);
        if (matched.length === 0) continue;
        for (const named of matched) named.remove();
        if (!decl.getDefaultImport() && !decl.getNamespaceImport() && decl.getNamedImports().length === 0) {
            decl.remove();
        }
    }
}

/** Whether an identifier with that name is used anywhere other than in imports */
export function isIdentifierUsed(sourceFile, name) {
    return sourceFile
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((id) => id.getText() === name && !id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration));
}

/** Cleans up unused named imports, for the given module only */
export function pruneUnusedImports(sourceFile, moduleName) {
    for (const decl of findImport(sourceFile, moduleName)) {
        let removed = false;
        for (const named of decl.getNamedImports()) {
            const local = named.getAliasNode()?.getText() ?? named.getName();
            if (isIdentifierUsed(sourceFile, local)) continue;
            named.remove();
            removed = true;
        }
        const def = decl.getDefaultImport();
        if (def && !isIdentifierUsed(sourceFile, def.getText())) {
            decl.removeDefaultImport();
            removed = true;
        }
        // Side-effect-only imports (`import 'x'`) never had names, so they are not removed
        if (removed && !decl.getDefaultImport() && !decl.getNamespaceImport() && decl.getNamedImports().length === 0) {
            decl.remove();
        }
    }
}

/** The innermost function containing node (arrow function, function expression, function declaration, or method) */
export function enclosingFunction(node) {
    return node.getFirstAncestor(
        (ancestor) =>
            Node.isArrowFunction(ancestor) ||
            Node.isFunctionExpression(ancestor) ||
            Node.isFunctionDeclaration(ancestor) ||
            Node.isMethodDeclaration(ancestor)
    );
}

/** Collects JSX elements (opening / self-closing tags) by tag name */
export function jsxOpeningsByTag(sourceFile, tagName) {
    return [
        ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ].filter((element) => element.getTagNameNode().getText() === tagName);
}

export function jsxAttribute(element, name) {
    return element.getAttributes().find((attribute) => Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === name);
}

/** Returns a JSX attribute's value as expression text (`a="x"` → `'x'`, `a={x}` → `x`) */
export function jsxAttributeExpression(attribute) {
    const initializer = attribute.getInitializer();
    if (!initializer) return 'true';
    if (Node.isJsxExpression(initializer)) return initializer.getExpression()?.getText() ?? 'undefined';
    return initializer.getText();
}

export const log = {
    step: (message) => console.log(`\n\x1b[1m▶ ${message}\x1b[0m`),
    info: (message) => console.log(`  ${message}`),
    warn: (message) => console.log(`  \x1b[33m! ${message}\x1b[0m`),
    ok: (message) => console.log(`  \x1b[32m✓ ${message}\x1b[0m`),
};
