# Contributing

## Setup

```sh
npm install
npm test            # unit tests and fixture conversions without installing anything (seconds)
npm run test:e2e    # converts the fixtures for real: install, type check, build, serve (minutes, needs the network)
                    # pnpm, Yarn and Bun runs are skipped when that package manager is not installed
```

Node.js 22.22 or newer is required (it is what React Router 8 requires of the converted project). `.node-version` pins the version used for development.

## How the code is organised

| Path                             | What it does                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bin/next-to-react-router.mjs`   | CLI entry point                                                                                         |
| `lib/main.mjs`                   | The run, step by step: checks, source transforms, moving `pages/`, writing files, install, verification |
| `lib/context.mjs`                | What the codemod knows about the project (directories, path aliases, package manager)                   |
| `lib/config.mjs`                 | The project config file (`next-to-react-router.config.mjs`)                                             |
| `lib/transforms/`                | Source transforms, one concern per file. Each takes a ts-morph `SourceFile`                             |
| `lib/routes.mjs`, `lib/move.mjs` | The route table, and fixing imports after `pages/` moves                                                |
| `lib/config-files.mjs`           | package.json, tsconfig.json, ESLint, ignore files, env files, Vite config                               |
| `templates/`                     | Files copied into the converted project (`.tmpl` is stripped)                                           |
| `test/fixtures/`                 | Small Next.js apps the tests convert                                                                    |

## Adding or changing a transform

- Transforms collect text edits against the original AST (`Edits` in `lib/util.mjs`) and apply them at once;
  AST nodes become invalid as soon as the text changes.
- When a pattern cannot be converted safely, stop with `unsupported(node, message)`. Never skip silently: a
  conversion that looks finished but dropped behaviour is worse than one that stops.
- Add a unit test in `test/transforms.test.mjs`, and extend a fixture when the behaviour only shows at run time.
- Anything specific to one project belongs in that project's config file, not in this package.
