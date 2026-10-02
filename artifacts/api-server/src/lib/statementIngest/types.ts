/**
 * A watched location that carrier statements are dropped into.
 *
 * The ingest core only knows this interface, so a second transport (SFTP, a
 * carrier portal pull) is one more adapter and no change to dedupe, inference,
 * parse or reconcile.
 */
export interface SourceFile {
  /** Stable id within the source (Drive file id, SFTP path). */
  externalId: string;
  name: string;
  /** Name of the immediate parent folder; used as a carrier hint. */
  folderName: string | null;
  /**
   * Content fingerprint. A file replaced in place keeps its externalId but gets a
   * new checksum, which is how the core tells "new file" from "same file".
   */
  checksum: string;
  modifiedTime: Date | null;
  sizeBytes: number | null;
  /** False for things we cannot read as bytes (e.g. native Google Sheets). */
  downloadable: boolean;
}

export interface StatementSource {
  list(): Promise<SourceFile[]>;
  download(file: SourceFile): Promise<Buffer>;
}
