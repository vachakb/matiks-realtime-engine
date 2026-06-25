/// <reference lib="webworker" />
// Runs inside a Web Worker — owns the WebSocket off the main thread (RN-Web has no JS/UI split, so a
// Worker is the web equivalent of the native off-thread socket). ArrayBuffers transferred zero-copy.
declare const self: DedicatedWorkerGlobalScope;

let ws: WebSocket | null = null;
const enc = new TextEncoder();

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { cmd: 'connect' | 'send' | 'close'; url?: string; bytes?: ArrayBuffer };
  switch (m.cmd) {
    case 'connect': {
      ws = new WebSocket(m.url!);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => self.postMessage({ ev: 'open' });
      ws.onclose = () => self.postMessage({ ev: 'close' });
      ws.onmessage = (e: MessageEvent) => {
        const ab = typeof e.data === 'string' ? (enc.encode(e.data).buffer as ArrayBuffer) : (e.data as ArrayBuffer);
        self.postMessage({ ev: 'message', bytes: ab }, [ab]);
      };
      break;
    }
    case 'send':
      if (ws && m.bytes) ws.send(m.bytes);
      break;
    case 'close':
      ws?.close();
      break;
  }
};
