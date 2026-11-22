// Rewrites that turn pages (pages/**) into route modules
//
//   Page.getLayout = function getLayout(page) { … }  → export const handle = { getLayout(page) { … } }
//   NextPageWithLayout<P> / NextPage<P>              → FC<P>
//   a page with a loader                             → adds a default export that passes loaderData as props, and headers
import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { Edits, addNamedImport, unsupported } from '../util.mjs';

/** Statics React itself reads; they stay on the component. */
const REACT_STATICS = new Set(['displayName', 'propTypes', 'defaultProps', 'contextTypes']);

/** NextPage<P> (and project aliases of it such as NextPageWithLayout<P>) → FC<P> */
export function transformPageTypes(sourceFile, pageTypeNames) {
    const edits = new Edits(sourceFile);
    for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
        if (!pageTypeNames.has(reference.getTypeName().getText())) continue;
        edits.replace(reference.getTypeName(), 'FC');
        // FC takes the props type only (NextPage<P, IP> has a second parameter for getInitialProps).
        const args = reference.getTypeArguments();
        if (args.length > 1) edits.replaceRange(args[0].getEnd(), args[args.length - 1].getEnd(), '');
    }
    if (!edits.apply()) return false;
    for (const decl of sourceFile.getImportDeclarations()) {
        const pageTypes = decl.getNamedImports().filter((named) => pageTypeNames.has(named.getName()));
        if (pageTypes.length === 0) continue;
        for (const named of pageTypes) named.remove();
        // Never drop side-effect imports (`import './x.scss'`): only remove a declaration this emptied.
        if (!decl.getDefaultImport() && !decl.getNamespaceImport() && decl.getNamedImports().length === 0) decl.remove();
    }
    addNamedImport(sourceFile, 'react', 'FC', { typeOnly: true });
    return true;
}

function defaultExportName(sourceFile) {
    const assignment = sourceFile.getExportAssignment((candidate) => !candidate.isExportEquals());
    const expression = assignment?.getExpression();
    if (expression && Node.isIdentifier(expression)) return expression.getText();
    return (
        sourceFile
            .getFunctions()
            .find((fn) => fn.isDefaultExport())
            ?.getName() ?? null
    );
}

/**
 * Statics assigned to the page component → the route's `handle`.
 *   Page.getLayout = (page) => <Layout>{page}</Layout>;  →  export const handle = { getLayout: (page) => … };
 * (_app reads them through the matched route instead of `Component.getLayout`.)
 */
export function transformPageStatics(sourceFile) {
    const component = defaultExportName(sourceFile);
    if (!component) return false;
    const statics = [];
    let needsReactElement = false;
    for (const statement of sourceFile.getStatements()) {
        if (!Node.isExpressionStatement(statement)) continue;
        const expression = statement.getExpression();
        if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getText() !== '=') continue;
        const left = expression.getLeft();
        if (!Node.isPropertyAccessExpression(left) || left.getExpression().getText() !== component) continue;
        if (REACT_STATICS.has(left.getName())) continue;
        if (left.getName() === 'getInitialProps') unsupported(statement, 'getInitialProps is not supported; use getServerSideProps');
        let value = expression.getRight().getText();
        // The page type used to give getLayout's parameter its type; on a plain object it needs an annotation.
        const fn = expression.getRight();
        if (left.getName() === 'getLayout' && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
            const [param] = fn.getParameters();
            if (param && !param.getTypeNode() && Node.isIdentifier(param.getNameNode())) {
                const offset = fn.getStart();
                const parenthesized = sourceFile.getFullText()[param.getStart() - 1] === '(';
                const annotated = parenthesized ? `${param.getName()}: ReactElement` : `(${param.getName()}: ReactElement)`;
                value = value.slice(0, param.getStart() - offset) + annotated + value.slice(param.getEnd() - offset);
                needsReactElement = true;
            }
        }
        statics.push({ statement, name: left.getName(), value });
    }
    if (statics.length === 0) return false;
    if (sourceFile.getVariableDeclaration('handle')) unsupported(statics[0].statement, 'This page already has something named `handle`');
    const edits = new Edits(sourceFile);
    const [first, ...rest] = statics;
    edits.replace(first.statement, `export const handle = {\n${statics.map(({ name, value }) => `    ${name}: ${value},`).join('\n')}\n};`);
    for (const { statement } of rest) edits.removeStatement(statement);
    edits.apply();
    if (needsReactElement) addNamedImport(sourceFile, 'react', 'ReactElement', { typeOnly: true });
    return true;
}

/**
 * Adds, to a page that has a loader, a default export that passes loaderData as props, and headers.
 * (Next passes the props from getServerSideProps to the page component, whereas React Router passes them as loaderData.)
 */
export function wrapPageWithLoaderData(sourceFile) {
    const baseName = path.basename(sourceFile.getFilePath()).replace(/\.[^.]+$/, '');
    const edits = new Edits(sourceFile);
    let component = null;

    const assignment = sourceFile.getExportAssignment((candidate) => !candidate.isExportEquals());
    const defaultFunction = sourceFile.getFunctions().find((fn) => fn.isDefaultExport());
    if (assignment) {
        const expression = assignment.getExpression();
        if (!Node.isIdentifier(expression)) unsupported(assignment, 'export default must be an identifier');
        component = expression.getText();
        edits.removeStatement(assignment);
    } else if (defaultFunction) {
        component = defaultFunction.getName() ?? unsupported(defaultFunction, 'An anonymous default export is not supported');
        // A page that takes no props does not need loaderData passed to it
        if (defaultFunction.getParameters().length > 0) {
            const exportKeyword = defaultFunction.getFirstModifierByKindOrThrow(SyntaxKind.ExportKeyword);
            const defaultKeyword = defaultFunction.getFirstModifierByKindOrThrow(SyntaxKind.DefaultKeyword);
            edits.replaceRange(exportKeyword.getStart(), defaultKeyword.getEnd() + 1, '');
        } else {
            component = null;
        }
    } else {
        unsupported(sourceFile, 'No default export found');
    }

    const full = sourceFile.getFullText();
    const blocks = [
        '// Pass the response headers set by the loader (Cache-Control etc.) through to the page response as they are',
        'export function headers({ loaderHeaders }: Route.HeadersArgs) {\n    return loaderHeaders;\n}',
    ];
    if (component) {
        blocks.push(
            `export default function ${component}Route({ loaderData }: Route.ComponentProps) {\n    return <${component} {...loaderData} />;\n}`
        );
    }
    edits.insert(
        full.length,
        `${full.endsWith('\n') ? '' : '\n'}\n${blocks.join('\n\n').replace('\n\nexport function headers', '\nexport function headers')}\n`
    );
    edits.apply();
    sourceFile.addImportDeclaration({ moduleSpecifier: `./+types/${baseName}`, namedImports: ['Route'], isTypeOnly: true });
    return true;
}

/** Adds a loader returning the matching HTTP status to the 404 / 500 pages (Next serves /404 and /500 with those statuses) */
export function addStatusLoader(sourceFile, status) {
    if (sourceFile.getExportedDeclarations().has('loader')) return false;
    sourceFile.addStatements(
        `\n// This page is served with HTTP ${status}\nexport function loader() {\n    return data(null, { status: ${status} });\n}`
    );
    addNamedImport(sourceFile, 'react-router', 'data');
    return true;
}
