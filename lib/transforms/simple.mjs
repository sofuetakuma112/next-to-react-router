// Replacements that are self-contained within one file: next/link, next/image, next/head, next/script, environment variables, etc.
import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from 'image-size';
import { Node, SyntaxKind } from 'ts-morph';
import { toRouterPattern } from '../routes.mjs';
import { Edits, addNamedImport, findImport, jsxAttribute, jsxOpeningsByTag, pruneUnusedImports, unsupported } from '../util.mjs';
import { mayBeRelativeHref, reachableUrlObjects } from './href.mjs';

/** Removes a leading 'use client' (it has no meaning in React Router's framework mode) */
export function removeUseClient(sourceFile) {
    const first = sourceFile.getStatements()[0];
    if (first && Node.isExpressionStatement(first) && /^['"]use client['"];?$/.test(first.getText())) {
        first.remove();
        return true;
    }
    return false;
}

/**
 * process.env.NEXT_PUBLIC_X → import.meta.env.VITE_X
 * comparisons against process.env.NODE_ENV → import.meta.env.DEV / PROD
 * any other process.env.X is left as is, as a value read on the server at runtime (the names are collected in report)
 */
export function transformEnv(sourceFile, report) {
    const edits = new Edits(sourceFile);
    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getExpression().getText() !== 'process.env') continue;
        const name = access.getName();
        if (name.startsWith('NEXT_PUBLIC_')) {
            const viteName = `VITE_${name.slice('NEXT_PUBLIC_'.length)}`;
            report.publicEnv.add(viteName);
            edits.replace(access, `import.meta.env.${viteName}`);
            continue;
        }
        if (name !== 'NODE_ENV') {
            report.serverEnv.add(name);
            continue;
        }
        const parent = access.getParent();
        if (Node.isBinaryExpression(parent)) {
            const operator = parent.getOperatorToken().getText();
            const other = parent.getLeft() === access ? parent.getRight() : parent.getLeft();
            const value = Node.isStringLiteral(other) ? other.getLiteralValue() : null;
            const flag = value === 'development' ? 'DEV' : value === 'production' ? 'PROD' : null;
            if (flag && (operator === '===' || operator === '==')) {
                edits.replace(parent, `import.meta.env.${flag}`);
                continue;
            }
            if (flag && (operator === '!==' || operator === '!=')) {
                edits.replace(parent, `!import.meta.env.${flag}`);
                continue;
            }
        }
        edits.replace(access, 'import.meta.env.MODE');
    }
    return edits.apply();
}

/**
 * Queues the edits that turn a Next UrlObject ({ pathname, query }) into a React Router To ({ pathname, search }).
 * @returns true if searchOf was used
 */
export function convertUrlObject(edits, objectLiteral) {
    let usedSearchOf = false;
    for (const property of objectLiteral.getProperties()) {
        if (Node.isShorthandPropertyAssignment(property)) {
            if (property.getName() === 'query') {
                edits.replace(property, 'search: searchOf(query)');
                usedSearchOf = true;
            }
            continue;
        }
        if (!Node.isPropertyAssignment(property)) unsupported(property, 'This form of URL object is not supported');
        const name = property.getName();
        if (name === 'query') {
            const initializer = property.getInitializerOrThrow();
            edits.replace(property.getNameNode(), 'search');
            edits.insertBefore(initializer, 'searchOf(');
            edits.insertAfter(initializer, ')');
            usedSearchOf = true;
        } else if (!['pathname', 'hash', 'search'].includes(name)) {
            unsupported(property, `URL object: ${name} is not supported`);
        }
    }
    return usedSearchOf;
}

/**
 * Converts every URL object inside an expression, including ones written in the branches of a
 * conditional expression or `||`, as in `cond ? '/a' : { pathname, query }`.
 * @returns true if searchOf was used
 */
export function convertUrlExpression(edits, expression) {
    if (Node.isObjectLiteralExpression(expression)) return convertUrlObject(edits, expression);
    if (Node.isParenthesizedExpression(expression)) return convertUrlExpression(edits, expression.getExpression());
    if (Node.isConditionalExpression(expression)) {
        const whenTrue = convertUrlExpression(edits, expression.getWhenTrue());
        return convertUrlExpression(edits, expression.getWhenFalse()) || whenTrue;
    }
    if (Node.isBinaryExpression(expression) && ['||', '??', '&&'].includes(expression.getOperatorToken().getText())) {
        const left = convertUrlExpression(edits, expression.getLeft());
        return convertUrlExpression(edits, expression.getRight()) || left;
    }
    return false;
}

/**
 * Converts the URL objects an href or router.push argument evaluates to when they are written elsewhere, such as a
 * function's return value or a constant (the ones written inside the expression are left to convertUrlExpression).
 * Objects in another file cannot be edited from here, so they are reported instead.
 * @returns true if searchOf was used
 */
export function convertReachableUrlObjects(edits, expression, context) {
    const sourceFile = edits.sourceFile;
    const converted = (edits.convertedUrlObjects ??= new Set());
    let usedSearchOf = false;
    for (const literal of reachableUrlObjects(expression)) {
        const file = literal.getSourceFile();
        if (file === sourceFile && literal.getStart() >= expression.getStart() && literal.getEnd() <= expression.getEnd()) continue;
        const key = `${file.getFilePath()}:${literal.getStart()}`;
        if (converted.has(key)) continue;
        converted.add(key);
        if (file !== sourceFile) {
            context.warn(
                `${file.getFilePath()}:${literal.getStartLineNumber()}: this { pathname, query } object reaches a <Link> or router.push in ` +
                    `${sourceFile.getFilePath()}. React Router ignores query: change it to search: searchOf(…) from app/lib/navigation.`
            );
            continue;
        }
        usedSearchOf = convertUrlObject(edits, literal) || usedSearchOf;
    }
    return usedSearchOf;
}

/**
 * next/link → react-router's Link (href → to).
 * When an href may be a relative path, the file uses the generated Link instead, which resolves it the way next/link did
 * (see href.mjs).
 */
export function transformLink(sourceFile, context) {
    const [decl] = findImport(sourceFile, 'next/link');
    if (!decl) return false;
    const local = decl.getDefaultImport()?.getText();
    if (!local || decl.getNamedImports().length > 0) unsupported(decl, 'This form of next/link import is not supported');

    const edits = new Edits(sourceFile);
    let usedSearchOf = false;
    let mayBeRelative = false;
    for (const element of jsxOpeningsByTag(sourceFile, local)) {
        const href = jsxAttribute(element, 'href');
        // Without an href attribute, it comes from a spread ({...props})
        if (!href) mayBeRelative = true;
        for (const attribute of element.getAttributes()) {
            if (!Node.isJsxAttribute(attribute)) continue;
            const name = attribute.getNameNode().getText();
            if (name === 'href') {
                edits.replace(attribute.getNameNode(), 'to');
                const initializer = attribute.getInitializer();
                const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
                mayBeRelative ||= mayBeRelativeHref(expression);
                if (expression) usedSearchOf = convertUrlExpression(edits, expression) || usedSearchOf;
                if (expression) usedSearchOf = convertReachableUrlObjects(edits, expression, context) || usedSearchOf;
            } else if (name === 'scroll') {
                // scroll={false} means "do not reset the scroll position after navigating"
                if (attribute.getInitializer()?.getText() !== '{false}') unsupported(attribute, 'scroll is only supported as {false}');
                edits.replace(attribute, 'preventScrollReset');
            } else if (['passHref', 'legacyBehavior', 'shallow', 'locale', 'as', 'prefetch'].includes(name)) {
                unsupported(attribute, `next/link: ${name} is not supported`);
            }
        }
    }
    edits.apply();

    findImport(sourceFile, 'next/link')[0].remove();
    const linkModule = mayBeRelative ? context.moduleSpecifier(sourceFile, 'link') : 'react-router';
    if (local === 'Link') addNamedImport(sourceFile, linkModule, 'Link');
    else sourceFile.addImportDeclaration({ moduleSpecifier: linkModule, namedImports: [{ name: 'Link', alias: local }] });
    if (usedSearchOf) addNamedImport(sourceFile, context.moduleSpecifier(sourceFile, 'navigation'), 'searchOf');
    return true;
}

/** next/image → the project's own Image component (same props; `/_image` does the resizing). */
export function transformImage(sourceFile, context) {
    const decls = findImport(sourceFile, 'next/image');
    for (const decl of decls) {
        for (const named of decl.getNamedImports()) {
            if (!['StaticImageData', 'ImageProps'].includes(named.getName())) {
                unsupported(named, `next/image: ${named.getName()} is not supported`);
            }
        }
        decl.setModuleSpecifier(context.moduleSpecifier(sourceFile, 'image'));
    }
    return decls.length > 0;
}

const IMAGE_EXTENSION = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp)$/i;

function svgSize(file) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
    const attr = (name) => {
        const value = new RegExp(`\\s${name}=["']([\\d.]+)(px)?["']`, 'i').exec(tag)?.[1];
        return value ? Number(value) : null;
    };
    const viewBox = /\sviewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
    const width = attr('width') ?? (viewBox ? Number(viewBox[1]) : null);
    const height = attr('height') ?? (viewBox ? Number(viewBox[2]) : null);
    return width && height ? { width: Math.round(width), height: Math.round(height) } : null;
}

function readImageSize(file) {
    if (/\.svg$/i.test(file)) return svgSize(file);
    try {
        const { width, height } = imageSize(fs.readFileSync(file));
        return width && height ? { width, height } : null;
    } catch {
        return null;
    }
}

/**
 * Image file imports. Next.js turns them into `{ src, width, height }`; Vite turns them into a URL string.
 * Keep the Next.js shape so `<Image src={logo} />` and `logo.src` continue to work:
 * - files under public/ are served as-is, so the import becomes a constant with the public URL
 * - other files stay imported (Vite fingerprints and bundles them) and the constant wraps the URL
 */
export function transformStaticImageImports(sourceFile, context) {
    const replacements = [];
    for (const decl of sourceFile.getImportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        if (!IMAGE_EXTENSION.test(specifier) || decl.isTypeOnly()) continue;
        const local = decl.getDefaultImport()?.getText();
        if (!local || decl.getNamedImports().length > 0) unsupported(decl, 'Image files can only be imported as a default import');
        const file = context.resolveSpecifier(sourceFile.getFilePath(), specifier);
        if (!file || !fs.existsSync(file)) unsupported(decl, `Image file not found: ${specifier}`);
        const size = readImageSize(file);
        if (!size) unsupported(decl, `Could not read the dimensions of ${specifier}`);
        const publicPrefix = context.publicDir + path.sep;
        if (file.startsWith(publicPrefix)) {
            const src = encodeURI(`/${path.relative(context.publicDir, file).split(path.sep).join('/')}`);
            replacements.push({ decl, text: `const ${local} = { src: '${src}', width: ${size.width}, height: ${size.height} };` });
        } else {
            decl.setDefaultImport(`${local}Url`);
            replacements.push({ decl: null, text: `const ${local} = { src: ${local}Url, width: ${size.width}, height: ${size.height} };` });
        }
    }
    if (replacements.length === 0) return false;
    for (const { decl } of replacements) decl?.remove();
    const imports = sourceFile.getImportDeclarations();
    const index = imports.length > 0 ? imports[imports.length - 1].getChildIndex() + 1 : 0;
    sourceFile.insertStatements(index, ['', ...replacements.map((replacement) => replacement.text)].join('\n'));
    return true;
}

/** next/dynamic → the generated `dynamic()` helper (React.lazy + Suspense, with the same call signature). */
export function transformDynamic(sourceFile, context) {
    const decls = findImport(sourceFile, 'next/dynamic');
    for (const decl of decls) {
        if (decl.getNamedImports().length > 0) unsupported(decl, 'next/dynamic: only the default import is supported');
        decl.setModuleSpecifier(context.moduleSpecifier(sourceFile, 'dynamic'));
    }
    return decls.length > 0;
}

/**
 * next/head → React 19 metadata (<title>, <meta>, and <link> are hoisted to <head> wherever they are written).
 * <Head> becomes a fragment, and stylesheet <link>s get a precedence (without it they are not hoisted to <head>).
 */
export function transformHead(sourceFile) {
    const [decl] = findImport(sourceFile, 'next/head');
    if (!decl) return false;
    const local = decl.getDefaultImport()?.getText();
    if (!local) unsupported(decl, 'This form of next/head import is not supported');

    const edits = new Edits(sourceFile);
    for (const element of sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement)) {
        const opening = element.getOpeningElement();
        if (opening.getTagNameNode().getText() !== local) continue;
        if (opening.getAttributes().length > 0) unsupported(opening, 'Attributes on <Head> are not supported');
        edits.replace(opening, '<>');
        edits.replace(element.getClosingElement(), '</>');

        for (const title of element.getDescendantsOfKind(SyntaxKind.JsxElement)) {
            if (title.getOpeningElement().getTagNameNode().getText() !== 'title') continue;
            const children = title.getJsxChildren().filter((child) => child.getText().trim() !== '');
            if (children.length !== 1) unsupported(title, '<title> must contain a single string (a React 19 restriction)');
        }
        for (const link of [
            ...element.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
            ...element.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ]) {
            if (link.getTagNameNode().getText() !== 'link') continue;
            const rel = jsxAttribute(link, 'rel')?.getInitializer()?.getText();
            if (rel && /^["']stylesheet["']$/.test(rel) && !jsxAttribute(link, 'precedence')) {
                edits.insertAfter(link.getTagNameNode(), ' precedence="default"');
            }
        }
    }
    edits.apply();
    pruneUnusedImports(sourceFile, 'next/head');
    if (findImport(sourceFile, 'next/head').length > 0) unsupported(decl, 'Uses of next/head other than <Head> are not supported');
    return true;
}

/**
 * next/script → the generated Script component, which has the same props and loading strategies
 * (beforeInteractive: in the HTML; afterInteractive: added after hydration; lazyOnload: added after the load event).
 */
export function transformScript(sourceFile, context) {
    const decls = findImport(sourceFile, 'next/script');
    if (decls.length === 0) return false;
    for (const decl of decls) {
        const local = decl.getDefaultImport()?.getText();
        if (!local || decl.getNamedImports().some((named) => named.getName() !== 'ScriptProps')) {
            unsupported(decl, 'next/script: only the default import (and the ScriptProps type) is supported');
        }
        for (const element of jsxOpeningsByTag(sourceFile, local)) {
            const strategy = jsxAttribute(element, 'strategy')?.getInitializer()?.getText();
            if (strategy && /worker/.test(strategy)) unsupported(element, 'next/script: strategy="worker" (Partytown) is not supported');
            if (element.getAttributes().some((attribute) => Node.isJsxSpreadAttribute(attribute))) {
                unsupported(element, 'next/script: spread props are not supported');
            }
        }
        decl.setModuleSpecifier(context.moduleSpecifier(sourceFile, 'script'));
    }
    return true;
}

const ROUTE_PATTERN_CHUNK = /^(\/[\w\-.]*|\/\[(\.\.\.)?[A-Za-z_]\w*\])+$/;

/**
 * Converts Next-style route patterns written in code ('/posts/[id]') to React Router style ('/posts/:id').
 * The targets are strings compared against router.pathname (→ useRoutePattern()).
 */
export function transformRoutePatternLiterals(sourceFile) {
    const edits = new Edits(sourceFile);
    const convert = (node) => {
        // Template literal pieces include `…${` or `}…`, so extract just the contents and inspect those
        const text = node.getText();
        const match = /^(['"`]|\}|)(.*?)(['"`]|\$\{|)$/s.exec(text);
        if (!match) return;
        const [, open, body, close] = match;
        if (!body.includes('/[') || !ROUTE_PATTERN_CHUNK.test(body)) return;
        edits.replace(node, `${open}${toRouterPattern(body)}${close}`);
    };
    for (const kind of [
        SyntaxKind.StringLiteral,
        SyntaxKind.NoSubstitutionTemplateLiteral,
        SyntaxKind.TemplateHead,
        SyntaxKind.TemplateMiddle,
        SyntaxKind.TemplateTail,
    ]) {
        for (const node of sourceFile.getDescendantsOfKind(kind)) {
            if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue;
            convert(node);
        }
    }
    return edits.apply();
}

/** Rewrites the image optimization endpoint (/_next/image) inside strings to the new path */
export function transformImageEndpointLiterals(sourceFile) {
    const edits = new Edits(sourceFile);
    for (const kind of [
        SyntaxKind.StringLiteral,
        SyntaxKind.NoSubstitutionTemplateLiteral,
        SyntaxKind.TemplateHead,
        SyntaxKind.TemplateMiddle,
        SyntaxKind.TemplateTail,
    ]) {
        for (const node of sourceFile.getDescendantsOfKind(kind)) {
            const text = node.getText();
            if (text.includes('/_next/image')) edits.replace(node, text.replaceAll('/_next/image', '/_image'));
        }
    }
    return edits.apply();
}
