// Project configuration (`next-to-react-router.config.mjs`).
//
// The codemod converts common Next.js patterns on its own. The config file is the escape hatch for the parts
// of a project that are too specific to convert mechanically: hand-written replacements for files such as
// `_app.tsx`, route grouping, extra dependencies and text replacements in non-code files.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodemodError } from './util.mjs';

export const CONFIG_FILE_NAMES = ['next-to-react-router.config.mjs', 'next-to-react-router.config.js'];

const KNOWN_KEYS = new Set([
    'files',
    'replaces',
    'routes',
    'packages',
    'textReplacements',
    'reviewedLibraries',
    'notes',
    'legacyImageRoute',
]);

/**
 * @typedef {object} ProjectConfig
 * @property {Record<string, string>} [files]
 *   Files to write as-is instead of generating them. Key: destination path relative to the project root
 *   (e.g. `app/root.tsx`). Value: source file, relative to the config file.
 * @property {Record<string, { sha256: string, by: string | string[] }>} [replaces]
 *   Source files that `files` replace by hand. The codemod stops when the content hash of such a file changes,
 *   because the hand-written replacement probably needs the same change.
 * @property {{ layouts?: { file: string, id?: string, exclude?: string[], include?: string[] }[] }} [routes]
 *   Layout routes wrapping groups of pages. `file` is relative to the app directory. A page belongs to the first
 *   layout whose `include` (default: everything) matches and whose `exclude` does not; patterns are route
 *   patterns such as `/blog` and match the route itself and everything below it.
 * @property {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string>, remove?: string[] }} [packages]
 * @property {{ files: string[], replacements: [string | RegExp, string][] }[]} [textReplacements]
 *   Plain-text replacements for files the codemod does not understand (deploy scripts, README, …).
 * @property {string[]} [reviewedLibraries] Libraries to leave out of the React 19 `defaultProps` warning.
 * @property {string[]} [notes] Lines printed at the end of the run.
 * @property {boolean} [legacyImageRoute] Also serve `/_next/image` (default: true).
 */

export function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadConfig(root, explicitPath) {
    const file = explicitPath
        ? path.resolve(explicitPath)
        : CONFIG_FILE_NAMES.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate));
    if (!file) return { file: null, dir: root, value: {} };
    if (!fs.existsSync(file)) throw new CodemodError(`Config file not found: ${file}`);
    const loaded = await import(pathToFileURL(file).href);
    const value = loaded.default ?? {};
    for (const key of Object.keys(value)) {
        if (!KNOWN_KEYS.has(key)) throw new CodemodError(`${path.basename(file)}: unknown option "${key}"`);
    }
    return { file, dir: path.dirname(file), value };
}

/** Stops when a hand-replaced source file no longer matches the content the replacement was written for. */
export function checkReplacedFiles(context) {
    const { root, config, options } = context;
    const drifted = [];
    for (const [file, { sha256: expected, by }] of Object.entries(config.value.replaces ?? {})) {
        const full = path.join(root, file);
        const replacement = [by].flat().join(', ');
        if (!fs.existsSync(full)) drifted.push(`${file} (missing) → ${replacement}`);
        else if (sha256(full) !== expected) drifted.push(`${file} → ${replacement}`);
    }
    if (drifted.length === 0 || options.acceptDrift) return;
    throw new CodemodError(
        [
            'These files changed since their hand-written replacements were made:',
            ...drifted.map((line) => `  - ${line}`),
            'Port the change to the replacement, then update the hash in the config file',
            '(`next-to-react-router --hash <file>` prints it) or rerun with --accept-drift.',
        ].join('\n')
    );
}

/** Destination paths (relative to the root, forward slashes) the project provides itself. */
export function providedFiles(context) {
    return new Set(Object.keys(context.config.value.files ?? {}).map((file) => file.split(path.sep).join('/')));
}

export function copyProvidedFiles(context) {
    const written = [];
    for (const [destination, source] of Object.entries(context.config.value.files ?? {})) {
        const from = path.resolve(context.config.dir, source);
        if (!fs.existsSync(from)) throw new CodemodError(`Config "files": source not found: ${from}`);
        const to = path.join(context.root, destination);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        written.push(destination);
    }
    return written;
}

function globToRegExp(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `^${escaped
            .replace(/\*\*\//g, '\u0000')
            .replace(/\*/g, '[^/]*')
            .replace(/\u0000/g, '(?:.*/)?')}$`
    );
}

export function applyTextReplacements(context, listFiles) {
    const groups = context.config.value.textReplacements ?? [];
    if (groups.length === 0) return [];
    const all = listFiles(context.root, () => true).map((file) => path.relative(context.root, file).split(path.sep).join('/'));
    const changed = [];
    for (const { files, replacements } of groups) {
        const patterns = files.map(globToRegExp);
        for (const relative of all.filter((file) => patterns.some((pattern) => pattern.test(file)))) {
            const full = path.join(context.root, relative);
            const source = fs.readFileSync(full, 'utf8');
            let output = source;
            for (const [search, replacement] of replacements) {
                output = typeof search === 'string' ? output.split(search).join(replacement) : output.replace(search, replacement);
            }
            if (output !== source) {
                fs.writeFileSync(full, output);
                changed.push(relative);
            }
        }
    }
    return changed;
}
