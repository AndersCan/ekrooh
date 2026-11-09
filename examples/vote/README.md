# Vote starter

Needs Node 20.19+ (`node -v`). Phones are optional: web works with Node alone.
Android: Android Studio. iOS: a Mac with Xcode (not on Linux/Windows).

Older Node? Install Node 22 from nodejs.org.

## Start

```sh
npx degit AndersCan/ekrooh/examples/vote my-app && cd my-app && npm install && npm run dev
```

You should see `vote ready: http://localhost:5173 ...`. Open it: three buttons, Tea (0), Coffee (0), Water (0). Click one and its count goes up.

## Vote from two devices

Votes are shared over p2p (`@ekrooh/bare/sync`). Each device counts its own votes and the page shows the sum.

1. On one device, open the page and copy the invite code.
2. On the other device, paste it in the box and press Join. The status line says "1 other device connected".
3. Vote on either: the count goes up on both.

On one computer, run `npm run dev:second` in a second terminal and open http://localhost:5174 as the second device.

Votes start from zero when the app restarts. If the status still says "Looking for the other device" after a minute, wait a little, then restart both apps: the first connection over the public network can be slow. A device that crashed can still show as connected until it comes back.

## Change the page

Edit `src/render.ts`. The browser and the Android emulator reload on save.

| File                     | What it is                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/render.ts`          | What you see                                                                                           |
| `src/main.ts`            | Connects the page to the app backend                                                                   |
| `src/vote-events.ts`     | The messages                                                                                           |
| `worklet/vote-plugin.ts` | Counts votes and shares them with `createSync`                                                         |
| `worklet/`               | The app backend. It runs in Node's sibling runtime Bare on your computer and inside the app on a phone |

## Run on Android

1. Install [Android Studio](https://developer.android.com/studio).
2. In the project folder, run `npm run sync` once (it builds the app backend and native parts), then `npm run dev` and leave it running.
3. In Android Studio, open the `android/` folder and wait for Gradle sync to finish.
4. Pick a device: Device Manager > Create Device > any Pixel with API 35. Press Run.
5. Edit `src/render.ts` and save. The emulator shows the change in a few seconds.

The app says `npm run dev` is not running? Start it on this computer and press Run again. The emulator reaches your computer at 10.0.2.2.

Changed `worklet/`? Run `npm run sync` and press Run again; only the page reloads live.

A USB phone (debugging on) and release builds show the page from the last `npm run sync`; run it again after an edit.

If Gradle says "Web build not found", run `npm run sync` first.

## Run on iOS

iOS needs a Mac. On Linux or Windows, skip this section; web and Android work fully.

1. Install Xcode from the App Store.
2. In the project folder, run `npm run sync`. Run it again after every edit.
3. Open `ios/Vote.xcodeproj` in Xcode. The first open downloads packages; this takes a few minutes.
4. Pick a Simulator and press Run. No Apple account is needed.

For a real iPhone: select the Vote target > Signing & Capabilities > Team > your Personal Team.

## Package manager

Use npm. pnpm and Yarn PnP are not supported (native packages need a flat node_modules).
