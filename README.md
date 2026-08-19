# zenera-neo

A TypeScript library targeting Node.js 20+ (ESM).

## Layout

```
src/            library source, `src/index.ts` is the public entry point
test/           unit tests (*.test.ts)
dist/           build output (generated)
```

## Scripts

| Command                 | Description                        |
| ----------------------- | ---------------------------------- |
| `npm run build`         | Compile `src/` to `dist/`          |
| `npm test`              | Run the unit tests once            |
| `npm run test:watch`    | Run the unit tests in watch mode   |
| `npm run test:coverage` | Run tests with a coverage report   |
| `npm run typecheck`     | Type-check without emitting output |

## Usage

```ts
import { greet } from 'zenera-neo';

greet('World'); // "Hello, World!"
```
