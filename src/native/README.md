# Native shim (iOS/Android) — Nitro Module

> **Status — design, not yet built.** This documents the off-thread **socket transport**
> (`NativeTransport` + the C++ sketch below), written against the engine's `Transport`
> interface but **not yet built or run end-to-end**. What *is* built and measured on a real
> device is the off-thread **AES-decrypt** Nitro module (`demo/modules/react-native-matiks-realtime`,
> see `reports/15`) — and that work showed the JSI *bridge crossing* of the payload, not the
> decrypt itself, is the wall. The code below is the intended shape, not a shipped artifact.

This is the engine's **native body**. The shared core (`../core/*`) is platform-agnostic and
fully unit-tested in Node; this layer just gives it a socket that lives on a **dedicated native
thread**, off the React Native JS thread (`mqt_v_js`) — the thread our Perfetto trace showed at
**39.7% on-CPU, the busiest in the app**, while 7 cores sat idle.

## Why this is the highest-leverage change
The duel never bottlenecked on the GPU (3.5%) — it bottlenecked on one JS thread doing socket
work + JSON + crypto. Moving the socket onto a native
thread is what frees that thread and puts the idle cores to work.

## How it's wired
1. `MatiksRealtime.nitro.ts` — the TypeScript spec. `nitrogen` generates the C++/Swift/Kotlin
   bindings from it (`npx nitrogen`). Hybrid Objects sit on `jsi::NativeState` and Nitro marshals
   the background-thread → JS callback safely.
2. `NativeTransport.ts` — implements the core `Transport` interface over the Nitro object, so the
   identical `RealtimeEngine` runs unchanged on device.

## C++ core sketch (the part that matters)
```cpp
// One dedicated event-loop thread owns the socket; JS is only pinged when a frame is ready.
class MatiksRealtime : public HybridMatiksRealtimeSpec {
  std::thread netThread_;
  ix::WebSocket ws_;                 // IXWebSocket: TLS + framing built-in, easy NDK link
  std::shared_ptr<react::CallInvoker> jsInvoker_;

  void connect(const std::string& url) override {
    ws_.setUrl(url);
    ws_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& m) {
      if (m->type == ix::WebSocketMessageType::Message) {
        auto buf = makeArrayBuffer(m->str);          // wrap bytes, zero-copy
        jsInvoker_->invokeAsync([=]{ onMessage_(buf); });  // hop to JS thread ONLY now
      }
    });
    ws_.start();                                     // runs its own thread
  }
  void send(const std::shared_ptr<ArrayBuffer>& f) override { ws_.sendBinary(f->view()); }
};
```

## Build (inside the Expo/RN app)
```bash
npm i react-native-nitro-modules
npx nitrogen          # generates bindings from the .nitro.ts spec
cd ios && pod install # iOS
# Android: CMake links IXWebSocket (or libwebsockets) + BoringSSL (NDK)
```

