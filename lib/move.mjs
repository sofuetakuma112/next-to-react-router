// Moving pages/ → app/routes/ and fixing the import paths that the move breaks.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'build', 'dist', 'public', '.react-router', '.cache', 'coverage']);
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;
const STYLE_FILE = /\.(scss|sass|css|less)$/;

/**
 * Files under `dir` that pass `filter`, skipping build output, dependencies and `skip`
 * (absolute directory paths).
 */
export function listFiles(dir, filter, skip = []) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) || skip.includes(full) ? [] : listFiles(full, filter, skip);
        return filter(full) ? [full] : [];
    });
}

function isInside(file, dir) {
    return file === dir || file.startsWith(dir + path.sep);
}

function relativeSpecifier(fromDir, target) {
    const relative = path.relative(fromDir, target).split(path.sep).join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Call after `from` was moved to `to` (absolute directories). Rewrites, in every code and style file of the
 * project, the relative imports and path-alias imports that pointed into `from` or that were written in a
 * moved file.
 * @returns number of files changed
 */
export function rewriteImportsAfterMove(context, from, to) {
    const { root, aliases } = context;
    const skip = context.packageDirInProject ? [path.join(root, context.packageDirInProject)] : [];
    let changedFiles = 0;

    for (const file of listFiles(root, (candidate) => CODE_FILE.test(candidate) || STYLE_FILE.test(candidate), skip)) {
        const moved = isInside(file, to);
        // A moved file's relative imports were written for its old location.
        const oldDir = moved ? path.dirname(path.join(from, path.relative(to, file))) : path.dirname(file);
        const newDir = path.dirname(file);
        const relocate = (target) => (isInside(target, from) ? path.join(to, path.relative(from, target)) : target);

        const rewrite = (specifier) => {
            const [pathPart, suffix = ''] = specifier.split(/(?=[?#])/, 2);
            const alias = aliases.find(({ prefix }) => pathPart.startsWith(prefix));
            if (alias) {
                const oldTarget = path.join(alias.dir, pathPart.slice(alias.prefix.length));
                const newTarget = relocate(oldTarget);
                return newTarget === oldTarget ? specifier : context.specifier(file, newTarget) + suffix;
            }
            if (!pathPart.startsWith('./') && !pathPart.startsWith('../')) return specifier;
            const newTarget = relocate(path.resolve(oldDir, pathPart));
            // Keep the specifier as written unless it now points somewhere else.
            return path.resolve(newDir, pathPart) === newTarget ? specifier : relativeSpecifier(newDir, newTarget) + suffix;
        };

        const source = fs.readFileSync(file, 'utf8');
        const output = CODE_FILE.test(file)
            ? source.replace(
                  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\2/g,
                  (match, head, quote, specifier) => `${head}${quote}${rewrite(specifier)}${quote}`
              )
            : source
                  .replace(
                      /(@(?:use|forward|import)\s+)(['"])([^'"\n]+)\2/g,
                      (match, head, quote, specifier) => `${head}${quote}${rewrite(specifier)}${quote}`
                  )
                  .replace(
                      /url\(\s*(['"]?)(\.{1,2}\/[^'")\s]+)\1\s*\)/g,
                      (match, quote, specifier) => `url(${quote}${rewrite(specifier)}${quote})`
                  );
        if (output !== source) {
            fs.writeFileSync(file, output);
            changedFiles++;
        }
    }
    return changedFiles;
}
