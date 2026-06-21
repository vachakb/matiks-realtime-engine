/**
 * Nitro Module spec for the NATIVE transport (iOS/Android).
 *
 * `nitrogen` statically generates the C++/Swift/Kotlin binding layer from this TypeScript
 * interface, so the socket, WebSocket framing, and (optionally) decode/decrypt run on a
 * dedicated native thread — OFF the React Native JS thread (`mqt_v_js`), which our Perfetto
 * trace showed pinned at ~40% on-CPU and starving frames. The JS side only ever receives a
 * fully-formed frame via a callback.
 *
 * Why Nitro over a classic TurboModule: Hybrid Objects are backed by `jsi::NativeState`
 * (lighter than `jsi::HostObject`), the bindings are statically typed, and Nitro safely
 * marshals the background-thread → JS callback for us. See https://nitro.margelo.com/.
 *
 * NOTE: this file builds inside an Expo/RN app with `react-native-nitro-modules`; it is the
 * native "body" of the engine and is intentionally not part of the Node-tested core.
 */
import type { HybridObject } from 'react-native-nitro-modules';

export interface MatiksRealtime extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** Open the WebSocket on the native thread (TLS handshake + Engine upgrade happen there). */
  connect(url: string): void;
  close(): void;

  /** Send a pre-encoded frame. `ArrayBuffer` is shared zero-copy across JSI. */
  send(frame: ArrayBuffer): void;

  // JS callbacks the native thread invokes (Nitro handles the thread hop via the CallInvoker).
  onOpen: () => void;
  onClose: () => void;
  onMessage: (frame: ArrayBuffer) => void;
  /** Surfaced for parity with the web transport. */
  readonly isOpen: boolean;
}
