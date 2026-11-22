// next/font/google → Fontsource (self-hosted font packages)
//
//   import { Inter } from 'next/font/google';
//   const inter = Inter({ weight: '500', subsets: ['latin'], variable: '--font-inter' });
// →
//   import '@fontsource/inter/latin-500.css';
//   import './fonts.css';                      // generated: .font-inter / .font-inter-variable
//   const inter = { className: 'font-inter', variable: 'font-inter-variable', style: { fontFamily: "'Inter'" } };
//
// `inter.className` / `inter.variable` / `inter.style` keep working as class names and styles.
import { Node } from 'ts-morph';
import { findImport, unsupported } from '../util.mjs';

function literal(node) {
    if (!node) return undefined;
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
    if (Node.isArrayLiteralExpression(node)) return node.getElements().map(literal);
    if (Node.isTrueLiteral(node)) return true;
    if (Node.isFalseLiteral(node)) return false;
    return unsupported(node, 'next/font options must be literals');
}

/** @returns {{ packages: Record<string, string>, css: string[] } | null} */
export function transformFont(sourceFile, context) {
    if (findImport(sourceFile, 'next/font/local').length > 0) {
        unsupported(
            findImport(sourceFile, 'next/font/local')[0],
            'next/font/local is not supported; declare the font with @font-face in a CSS file'
        );
    }
    const [decl] = findImport(sourceFile, 'next/font/google');
    if (!decl) return null;

    const packages = {};
    const css = [];
    const sideEffectImports = [];
    const replacements = [];
    for (const named of decl.getNamedImports()) {
        const fontFunction = named.getName();
        const local = named.getAliasNode()?.getText() ?? fontFunction;
        const family = fontFunction.replace(/_/g, ' ');
        const slug = family.toLowerCase().replace(/ /g, '-');

        for (const statement of sourceFile.getVariableStatements()) {
            for (const declaration of statement.getDeclarations()) {
                const call = declaration.getInitializer();
                if (!call || !Node.isCallExpression(call) || call.getExpression().getText() !== local) continue;
                if (statement.getDeclarations().length !== 1) unsupported(statement, 'Declare each font in its own statement');
                const [arg] = call.getArguments();
                const options = {};
                if (arg) {
                    if (!Node.isObjectLiteralExpression(arg)) unsupported(arg, 'next/font options must be an object literal');
                    for (const property of arg.getProperties()) {
                        if (!Node.isPropertyAssignment(property)) unsupported(property, 'next/font options must be plain properties');
                        options[property.getName()] = literal(property.getInitializerOrThrow());
                    }
                }
                const weights = options.weight === undefined || options.weight === 'variable' ? null : [options.weight].flat();
                const styles = [options.style ?? 'normal'].flat();
                const subsets = [options.subsets ?? ['latin']].flat();
                let fontFamily = family;
                if (weights) {
                    packages[`@fontsource/${slug}`] = '^5.0.0';
                    for (const subset of subsets) {
                        for (const weight of weights) {
                            for (const style of styles) {
                                sideEffectImports.push(`@fontsource/${slug}/${subset}-${weight}${style === 'italic' ? '-italic' : ''}.css`);
                            }
                        }
                    }
                } else {
                    // No weight: a variable font. Fontsource publishes those separately, under "<Family> Variable".
                    packages[`@fontsource-variable/${slug}`] = '^5.0.0';
                    fontFamily = `${family} Variable`;
                    sideEffectImports.push(`@fontsource-variable/${slug}/index.css`);
                    if (styles.includes('italic')) sideEffectImports.push(`@fontsource-variable/${slug}/wght-italic.css`);
                }
                const fallback = [options.fallback ?? []]
                    .flat()
                    .map((name) => `, ${/^[a-z-]+$/.test(name) ? name : `'${name}'`}`)
                    .join('');
                const stack = `'${fontFamily}'${fallback}`;
                const className = `font-${slug}`;
                css.push(`.${className} {\n    font-family: ${stack};\n}`);
                const fields = [`className: '${className}'`];
                if (typeof options.variable === 'string') {
                    css.push(`.${className}-variable {\n    ${options.variable}: ${stack};\n}`);
                    fields.push(`variable: '${className}-variable'`);
                }
                fields.push(`style: { fontFamily: ${JSON.stringify(stack)} }`);
                replacements.push({ call, text: `{ ${fields.join(', ')} }` });
            }
        }
    }
    if (replacements.length === 0) unsupported(decl, 'next/font/google: call the font function at the top level of the module');

    for (const { call, text } of replacements.reverse()) call.replaceWithText(text);
    findImport(sourceFile, 'next/font/google')[0].remove();
    const fontsCss = context.specifier(sourceFile.getFilePath(), context.modulePath('fonts'));
    context.report.usedModules.add('fonts');
    sourceFile.insertStatements(0, [...new Set(sideEffectImports), fontsCss].map((specifier) => `import '${specifier}';`).join('\n'));
    return { packages, css };
}
