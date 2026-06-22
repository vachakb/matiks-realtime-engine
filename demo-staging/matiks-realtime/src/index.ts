import { NitroModules } from 'react-native-nitro-modules'
import type { MatiksRealtime } from './MatiksRealtime.nitro'

export type { MatiksRealtime } from './MatiksRealtime.nitro'

/**
 * The singleton `MatiksRealtime` HybridObject instance.
 *
 * @example
 * ```ts
 * import { MatiksRealtime } from 'react-native-matiks-realtime'
 *
 * const plaintexts = await MatiksRealtime.decryptQuestions(blobs, key)
 * ```
 */
export const MatiksRealtime =
  NitroModules.createHybridObject<MatiksRealtime>('MatiksRealtime')
