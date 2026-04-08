# Slack OpenAPI 3.1 Generator

Auto-generate an OpenAPI 3.1.0 specification from the official Slack Node SDK via TypeScript AST analysis.

## The Problem

In 2024, Slack officially deprecated and abandoned their public OpenAPI specification. The Slack Web API is complex — it relies heavily on intersection types, literal string discriminators, and dynamic RPC payloads — so standard documentation scrapers constantly generate broken or missing schemas.

## How It Works

This tool doesn't scrape documentation or guess at types. Using [ts-morph](https://github.com/dsherret/ts-morph), `generate.js` reads the Abstract Syntax Tree (AST) of the official `@slack/web-api`, `@slack/bolt`, and `@slack/types` packages. It extracts the exact TypeScript generics used by Slack's engineers and transpiles them into a pristine OpenAPI 3.1.0 JSON file.

- **100% Offline** — no web scraping, no API calls
- **Strictly Typed** — resolves tuples, unions, intersections, literal enums, and index signatures
- **Always Up-to-Date** — a GitHub Action runs weekly to pull the latest SDK and regenerate the spec

The generated spec includes:

- **Web API endpoints** (paths) — extracted from the SDK's `Methods` class
- **Events, Actions, and Shortcuts** (webhooks) — extracted from Bolt's type definitions

## Getting the Schema

Grab the latest generated file directly: [slack-openapi-spec.json](./slack-openapi-spec.json)

## Running Locally

Requires Node.js >= 18.

```bash
git clone https://github.com/ilyabrin/slack-openapi-generator.git
cd slack-openapi-generator
npm install
node generate.js
```

The spec is written to `./slack-openapi-spec.json` by default. Pass a path argument to write elsewhere:

```bash
node generate.js ./output/my-spec.json
```

## Running Tests

```bash
npm test
```

## How the AST Parsing Works

1. **Load SDK types** — ts-morph loads all `.d.ts` files from `@slack/web-api`, `@slack/bolt`, and `@slack/types`
2. **Walk the Methods class** — the SDK's `Methods` class declares every API endpoint as a typed property. The generator recursively walks the property tree, finding leaf methods typed as `MethodWithRequiredArgument<Args, Response>` or `MethodWithOptionalArgument<Args, Response>`
3. **Map TypeScript to OpenAPI** — each type is recursively converted: literals become enums, unions become `anyOf` (with optimizations like enum collapsing and common property hoisting), intersections become `allOf` with inline object squashing, and named types become `$ref` components
4. **Disambiguate** — when two different types share the same name (e.g., bolt's `Authorization` vs web-api's `Authorization`), the registry detects the collision and assigns numbered variants
5. **Parse events** — interfaces ending in `Event`, `Action`, or `Shortcut` from the appropriate SDK directories become webhook definitions, wrapped in the `EnvelopedEvent` envelope where appropriate

## Contributing

Found a missing endpoint or a TypeScript edge case that isn't handled? Open an issue or submit a PR!

## License

[MIT](./LICENSE)
