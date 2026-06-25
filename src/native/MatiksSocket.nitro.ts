import type { HybridObject } from 'react-native-nitro-modules';

// Native WebSocket transport spec — nitrogen generates the C++/Swift/Kotlin bindings so the socket
// runs on a dedicated native thread (off `mqt_v_js`); JS only receives finished frames.
// Design-stage. The engine's built + on-device-measured Nitro module is the decrypt one at /modules.
export interface MatiksSocket extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  connect(url: string): void;
  close(): void;
  send(frame: ArrayBuffer): void;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (frame: ArrayBuffer) => void;
  readonly isOpen: boolean;
}
