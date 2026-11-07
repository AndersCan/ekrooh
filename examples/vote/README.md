# Vote starter

Needs Node 20.19+ (`node -v`). Phones are optional: web works with Node alone.
Android: Android Studio. iOS: a Mac with Xcode (not on Linux/Windows).

Older Node? Install Node 22 from nodejs.org.

## Start

```sh
npx degit AndersCan/ekrooh/examples/vote my-app && cd my-app && npm install && npm run dev
```

You should see `vote ready: http://localhost:5173 ...`. Open it: three buttons, Tea (0), Coffee (0), Water (0). Click one and its count goes up.

## Change the page

Edit `src/render.ts`. The browser reloads on save.

| File                 | What it is                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/render.ts`      | What you see                                                                                           |
| `src/main.ts`        | Connects the page to the app backend                                                                   |
| `src/vote-events.ts` | The messages                                                                                           |
| `worklet/`           | The app backend. It runs in Node's sibling runtime Bare on your computer and inside the app on a phone |

Android and iOS: coming in this folder soon.

## Package manager

Use npm. pnpm and Yarn PnP are not supported (native packages need a flat node_modules).
