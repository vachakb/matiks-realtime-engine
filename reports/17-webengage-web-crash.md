# 17 — "Something went wrong: Cannot read properties of null (reading 'uattr')"

A full-page crash on the **web app**, hit by randomly opening the Matiks tab; seen before as intermittent error screens that couldn't be reproduced. Traced to root cause by static analysis of the live bundles.

## It is not your code — it's the WebEngage SDK

`uattr` appears in **none** of Matiks' own JavaScript: not the entry bundle, not the 15 MB `__common` chunk, not any of the 204 lazy-loaded route chunks, not the captured GraphQL traffic. It appears in exactly one place — **`webengage-min-v-6.0.js`** (the WebEngage analytics SDK Matiks loads on web).

## Root cause

Every one of the 7 `uattr` reads in the SDK looks like this:

```js
getUserAttribute: function (e) { var t = m.getForever().uattr || {}; ... }
getPersonalizationContext: ...  m.getForever().uattr || {}
setProfile: ...                 var o = a.uattr || {}   // a = m.getForever()
setAttribute: ...               var o = u.getForever().uattr || {}
```

`getForever()` returns WebEngage's persisted state object, hydrated from `JSON.parse(localStorage.getItem(...))`. **When that storage key is missing, cleared, or evicted, `getForever()` returns `null`.** The `|| {}` guard protects against a missing `uattr` *property* — but `null.uattr` throws *first*, before `||` is ever evaluated:

```
getForever()  →  null
null.uattr    →  TypeError: Cannot read properties of null (reading 'uattr')
```

WebEngage runs during app init / personalization handling, so the unhandled error propagates into React and the **whole app falls back to the "Something went wrong" boundary** — a non-critical analytics tracker takes down the entire product.

## Why it's intermittent / unreproducible

It depends entirely on the browser's localStorage state at load:
- a long-idle / reopened tab whose WebEngage entry was **evicted** (storage pressure),
- **cleared** site data, privacy/incognito modes, or storage disabled,
- a **cross-tab race** (another tab clearing/rewriting WE storage),
- the brief window before WE re-initializes its store.

Normal sessions have the key populated, so it almost never fires for you — which is exactly why the earlier error screens couldn't be reproduced on demand.

## Fix

**For Matiks (don't wait on the vendor):**
1. **Isolate analytics so it can't crash the app.** A third-party tracker should never blank the product. Either wrap WebEngage init + calls in `try/catch`, or use an error boundary that, for non-critical SDK errors, logs and renders the app anyway instead of "Something went wrong."
2. This is the same theme as the PII-to-6-trackers finding: the trackers run in the app's own execution context with no isolation. The robust pattern is to sandbox/guard them.

**Report upstream to WebEngage:** the SDK should null-guard its own store — `(getForever() || {}).uattr` instead of `getForever().uattr || {}`. (Affects `getUserAttribute`, `getPersonalizationContext`, `setProfile`, `setAttribute`.)

## How this was found
Fetched the live `www.matiks.com` bundles (entry + `__common` + all 204 Expo route chunks) and the loaded vendor SDKs; grepped for `uattr`; isolated it to `webengage-min-v-6.0.js`; read the access sites and the `getForever()` definition. Static-analysis-confirmed (not runtime-reproduced — it's storage-state dependent).
