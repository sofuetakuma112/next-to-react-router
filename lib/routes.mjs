// Builds the React Router route table (app/routes.ts) from the file layout under pages/
import fs from 'node:fs';
import path from 'node:path';
import { CodemodError } from './util.mjs';

const PAGE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const SPECIAL_PAGES = new Set(['_app', '_document', '_error']);

function walk(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    });
}

/** Converts a Next dynamic segment to React Router syntax (`[id]` → `:id`, `[...path]` → `*`) */
export function toRouterSegment(segment) {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) {
        throw new CodemodError(`optional catch-all (${segment}) is not supported`);
    }
    if (/^\[\.\.\..+\]$/.test(segment)) return '*';
    const dynamic = /^\[(.+)\]$/.exec(segment);
    return dynamic ? `:${dynamic[1]}` : segment;
}

/** Converts a Next-style route pattern in a string (`/posts/[id]`) to React Router style (`/posts/:id`) */
export function toRouterPattern(pattern) {
    return pattern
        .split('/')
        .map((segment) => (/^\[.+\]$/.test(segment) ? toRouterSegment(segment) : segment))
        .join('/');
}

/**
 * @returns {{ file: string, path: string, pattern: string, index: boolean, score: number }[]}
 *   file is the path relative to pages/, path is the React Router route path, and pattern is the pattern starting with `/` (used as the route id)
 */
export function collectPageRoutes(pagesDir) {
    const routes = [];
    for (const file of walk(pagesDir).sort()) {
        const extension = PAGE_EXTENSIONS.find((ext) => file.endsWith(ext));
        if (!extension || file.endsWith('.d.ts')) continue;
        const withoutExtension = file.slice(0, -extension.length);
        const segments = withoutExtension.split('/');
        if (segments.length === 1 && SPECIAL_PAGES.has(segments[0])) continue;
        if (segments[0] === 'api') {
            throw new CodemodError(`API Routes (pages/${file}) are not supported`);
        }
        if (segments[segments.length - 1] === 'index') segments.pop();
        const routeSegments = segments.map(toRouterSegment);
        routes.push({
            file,
            path: routeSegments.join('/'),
            pattern: `/${routeSegments.join('/')}`,
            index: routeSegments.length === 0,
        });
    }
    const seen = new Map();
    for (const route of routes) {
        if (seen.has(route.pattern)) {
            throw new CodemodError(`Two pages resolve to the same URL: pages/${seen.get(route.pattern)} and pages/${route.file}`);
        }
        seen.set(route.pattern, route.file);
    }
    return routes;
}

function routeLine(route, indent) {
    const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const options = `{ id: ${quote(route.id ?? route.pattern)} }`;
    const file = quote(route.moduleFile ?? `routes/${route.file}`);
    return route.index ? `${indent}index(${file}, ${options}),` : `${indent}route(${quote(route.path)}, ${file}, ${options}),`;
}

function matchesPrefix(route, prefixes) {
    return prefixes.some((prefix) => prefix === '/' || route.pattern === prefix || route.pattern.startsWith(`${prefix}/`));
}

/**
 * The contents of app/routes.ts.
 * @param routes result of collectPageRoutes
 * @param layouts layout routes from the project config: `{ file, id?, include?, exclude? }[]`. A page goes into the
 *   first layout that includes and does not exclude it; pages in no layout sit at the top level.
 * @param notFoundPage the `/404` page, also mounted on `*` so unknown URLs render it
 * @param extraRoutes non-page routes to append (image optimization, …)
 */
export function renderRoutesFile(routes, { layouts = [], notFoundPage, extraRoutes = [] }) {
    const groups = layouts.map((layout) => ({ layout, routes: [] }));
    const topLevel = [];
    const place = (route) => {
        const group = groups.find(
            ({ layout }) => matchesPrefix(route, layout.include ?? ['/']) && !matchesPrefix(route, layout.exclude ?? [])
        );
        (group ? group.routes : topLevel).push(route);
    };
    // index (/) first, then by file name
    for (const route of [...routes].sort((a, b) => Number(b.index) - Number(a.index))) place(route);
    if (notFoundPage) {
        place({ ...notFoundPage, index: false, path: '*', id: '/*', comment: 'URLs that match no route render the 404 page' });
    }

    const used = new Set(['type RouteConfig']);
    const render = (list, indent) =>
        list.flatMap((route) => {
            used.add(route.index ? 'index' : 'route');
            return [...(route.comment ? [`${indent}// ${route.comment}`] : []), routeLine(route, indent)];
        });
    const body = [];
    for (const { layout, routes: grouped } of groups) {
        if (grouped.length === 0) continue;
        used.add('layout');
        const id = layout.id ?? layout.file.replace(/\.[^.]+$/, '');
        body.push(`    layout('${layout.file}', { id: '${id}' }, [`, ...render(grouped, '        '), '    ]),');
    }
    body.push(...render(topLevel, '    '), ...render(extraRoutes, '    '));

    used.add('type RouteConfigEntry');
    const names = ['type RouteConfig', 'type RouteConfigEntry', 'index', 'layout', 'route'].filter((name) => used.has(name));
    return [
        `import { ${names.join(', ')} } from '@react-router/dev/routes';`,
        '',
        '// Like Next.js, match URLs case-sensitively (/About is a 404). React Router ignores case by default.',
        'function caseSensitive(entries: RouteConfigEntry[]): RouteConfigEntry[] {',
        '    return entries.map((entry) => ({',
        '        ...entry,',
        '        caseSensitive: true,',
        '        ...(entry.children && { children: caseSensitive(entry.children) }),',
        '    }));',
        '}',
        '',
        '// Each route id is its path pattern; useRoutePattern() (app/lib/navigation.ts) reads it for the matched route.',
        'export default caseSensitive([',
        ...body,
        ']) satisfies RouteConfig;',
        '',
    ].join('\n');
}
