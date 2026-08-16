# Nanostores + lit-html rendering

Condensed reference for this repo. Implementation: [`examples/web/use-store.ts`](examples/web/use-store.ts).

## Core rule

Call **`render()` once** on the app root. Do not subscribe to stores with `effect()` (or similar) to re-run the whole template. Bind dynamic text with **`useStore($store)`** or **`useStore($store, select)`** so each binding subscribes via `store.listen()` and updates only that DOM node through `setValue()`.

Inside directives, use **`listen()`**, not `subscribe()`, so the initial value comes from `render()` and you do not get a redundant first callback.

## Consumer footguns

**`useStore` is only valid as a direct template expression** — `${useStore($x)}`
/ `${useStore($x, select)}`. It is a lit-html `AsyncDirective`: lit-html
evaluates it inside the directive lifecycle and replaces the returned marker
with the live value. Assigning the result to a variable and dereferencing it
gives you the directive marker, not the value — which crashes (`Cannot read
properties of undefined`) or silently breaks the branch:

```ts
// ❌ Wrong — `v` is a directive marker, not the store value
const v = useStore($x);
return html`${v}`;

// ✅ Right — direct template expression
return html`${useStore($x)}`;
```

To bind several atoms and read fields, do not compose `useStore` calls. Derive
one **`computed` view-model** and consume it with a single binding:

```ts
const $vm = computed([$user, $session], (user, session) => ({
  name: user.name,
  online: session.online,
}));

return html`${useStore($vm, (vm) => body(vm))}`;
```

The same applies to any directive wrapper you add (`useMapKey`, ...): it is a
marker for lit-html, not a value.

## Store patterns (nanostores)

- **`atom`** — single value; `set` / `get`.
- **`map`** — object; **`setKey`** so listeners can target keys (pair with `listenKeys` when you add a `useMapKey`-style directive).
- **`computed`** — derived, read-only, glitch-free; use for values derived from other stores so subscribers can depend on the minimum.
- **`batched`** — derived value recomputed once per microtask when several deps change together.
- **`onMount`** — run when the first listener appears; return cleanup when the last leaves (good for fetch, intervals). Subscriptions from **`useStore`** count as listeners.

## Lists (when you add them)

Use **`repeat()`** from `lit-html/directives/repeat.js` with a stable **key function** so reorder reuses DOM and only changed rows update. Often wrapped in `useStore($items, (items) => repeat(...))`.

## Routing

Router store: [`examples/web/router.ts`](examples/web/router.ts). In the shell template, use **`useStore($router, (page) => cache(routeView(page)))`** and wrap each route's subtree in **`cache()`** from `lit-html/directives/cache.js` so DOM is preserved across transitions and async directives are paused correctly. Use **`getPagePath($router, 'routeName')`** for `<a href>` so the router's document click handler can intercept in-app navigation.

## Memory: `AsyncDirective` and teardown

Standalone lit-html does not know when you remove the container from the document. Before discarding the rendered tree, get the **`RootPart`** returned from **`render()`** and call **`setConnected(false)`** so `useStore` (and similar) run **`disconnected()`** and unsubscribe. **`cache()`** handles subtree lifecycle for cached route views.

## When a full re-render is unavoidable

If a whole section must re-render from store updates, **batch** with `queueMicrotask` so multiple store events in one tick produce one `render()` pass.

## Optional: map key directive

For **`map`** stores, **`listenKeys($store, ['name', ...], cb)`** avoids firing on unrelated keys. A small **`useMapKey`** directive (same idea as `useStore`, but `listenKeys` instead of `listen`) is useful when you add map-backed UI; defer until then.

## Rules summary

| Practice                                      | Why                                                     |
| --------------------------------------------- | ------------------------------------------------------- |
| One root `render()`, directives for updates   | Avoids full template re-evaluation                      |
| `listen()` in directives                      | No duplicate initial push                               |
| `computed` / `batched` / `listenKeys`         | Minimal subscriptions, one update per tick where needed |
| `repeat` + keys                               | DOM reuse for lists                                     |
| `cache` for route views                       | Preserves DOM and directive lifecycle                   |
| `rootPart.setConnected(false)` before removal | Prevents subscription leaks                             |
