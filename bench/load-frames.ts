/** Loads real Matiks WebSocket frames from a capture JSONL (the Playwright CDP capture). */
import { readFileSync } from 'node:fs';

export interface LoadedFrame {
  dir: 'sent' | 'recv';
  channel: string;
  type: string;
  obj: unknown;
  text: string;
  jsonBytes: number;
}

export function loadFrames(path: string): LoadedFrame[] {
  const out: LoadedFrame[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'ws-frame') continue;
    const payload = e.payload as string;
    const text = e.encoding === 'text' ? payload : Buffer.from(payload, 'base64').toString('utf8');
    let obj: unknown;
    try { obj = JSON.parse(text); } catch { continue; }
    const o = obj as { channel?: string; type?: string };
    out.push({
      dir: e.dir as 'sent' | 'recv',
      channel: o.channel ?? '',
      type: o.type ?? '',
      obj,
      text,
      jsonBytes: Buffer.byteLength(text, 'utf8'),
    });
  }
  return out;
}

/** Normalize a channel name by stripping ids: GAME_EVENT_<hex>_V2 -> GAME_EVENT_V2. */
export function normalizeChannel(ch: string): string {
  return ch.replace(/_[0-9a-fA-F]{6,}/g, '');
}
