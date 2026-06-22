/**
 * Ambient declaration for the native module the *other* agent is authoring.
 *
 * This lets the demo type-check and import `react-native-matiks-realtime` before the package is
 * built/installed. The real module ships a Nitro HybridObject; per report
 * 13-native-decrypt-ondevice.md the decrypt entry point is async and runs on a background thread:
 *
 *     MatiksRealtime.decryptQuestions(blobs, key): Promise<Question[]>
 *
 * Keep this in sync with whatever the published package's own types declare.
 */
declare module 'react-native-matiks-realtime' {
  export interface Question {
    id: string;
    expression: string;
    answer: number;
    preset: string;
    rating: number;
  }

  export interface MatiksRealtimeModule {
    /**
     * Decrypt `"<ivHex>:<ctHex>"` AES-256-CBC blobs on a dedicated native thread and resolve
     * the parsed questions on the JS thread via the CallInvoker.
     */
    decryptQuestions(blobs: string[], key: string): Promise<Question[]>;

    // — transport surface from MatiksRealtime.nitro.ts (not exercised by this demo) —
    connect?(url: string): void;
    close?(): void;
    readonly isOpen?: boolean;
  }

  export const MatiksRealtime: MatiksRealtimeModule;
  const _default: MatiksRealtimeModule;
  export default _default;
}
