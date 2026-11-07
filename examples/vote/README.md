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

## Run on Android

1. Install [Android Studio](https://developer.android.com/studio).
2. In the project folder, run `npm run sync`. Run it again after every edit: the phone shows the built page, not the dev server.
3. In Android Studio, open the `android/` folder and wait for Gradle sync to finish.
4. Pick a device: Device Manager > Create Device > any Pixel with API 35, or a USB phone with debugging on. Press Run.

The app shows the same vote page. If Gradle says "Web build not found", run `npm run sync` first.

iOS: coming in this folder soon.

## Package manager

Use npm. pnpm and Yarn PnP are not supported (native packages need a flat node_modules).
