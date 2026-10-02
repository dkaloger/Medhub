import type { FileSink, RecordingStore } from '../core/recorder';
import { requireNative } from './NativeMedhub';

/** Recordings folder managed by the native module; part files are appended every second. */
export class NativeStore implements RecordingStore {
  readonly partSeconds = 600;

  private constructor(readonly location: string) {}

  static async open(): Promise<NativeStore> {
    return new NativeStore(await requireNative().recordingsRoot());
  }

  async createFile(folder: readonly string[], fileName: string): Promise<FileSink> {
    const { id, path } = await requireNative().createFile(folder.join('/'), fileName);
    return {
      path,
      append: (text) => requireNative().appendFile(id, text),
      close: () => requireNative().closeFile(id),
    };
  }
}
