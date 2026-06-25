# Native socket transport — design

The engine's `Transport` is swappable; this is the **native** impl. A Nitro Hybrid Object
(`MatiksSocket`) runs the WebSocket on a dedicated native thread (off `mqt_v_js`), so JS only
receives finished frames; `NativeTransport.ts` adapts it to the core `Transport`.

**Status: design — written against the interface, not yet built/run end-to-end.** The engine's
built and on-device-measured Nitro module is the off-thread **decrypt** module at
[`/modules/react-native-matiks-realtime`](../../modules/react-native-matiks-realtime).

C++ sketch — one event-loop thread owns the socket; JS is pinged only when a frame is ready:

```cpp
class MatiksSocket : public HybridMatiksSocketSpec {
  ix::WebSocket ws_;                                 // IXWebSocket: TLS + framing, easy NDK link
  std::shared_ptr<react::CallInvoker> jsInvoker_;
  void connect(const std::string& url) override {
    ws_.setUrl(url);
    ws_.setOnMessageCallback([this](auto m) {
      if (m->type == ix::WebSocketMessageType::Message)
        jsInvoker_->invokeAsync([=]{ onMessage_(makeArrayBuffer(m->str)); }); // hop to JS only now
    });
    ws_.start();
  }
  void send(const std::shared_ptr<ArrayBuffer>& f) override { ws_.sendBinary(f->view()); }
};
```
