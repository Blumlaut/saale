/**
 * The vocabulary shared by the file API, the browser component and the
 * providers behind them.
 */

export type FileKind = "file" | "directory";

/** One row of a directory listing. */
export interface FileEntry {
  /** Last path segment. what the row shows. */
  name: string;
  /** Absolute path within the workspace. */
  path: string;
  kind: FileKind;
  /** Bytes; a directory reports its own size, which is rarely meaningful. */
  size: number;
  /** Epoch milliseconds. Open Terminal answers in seconds, providers convert. */
  modified: number;
  /** Whether the workspace account could write here. */
  writable: boolean;
}

/**
 * What a caller may do to a workspace.
 *
 * Advertised per target so the UI can hide what it cannot do rather than
 * offering a button that fails. a read-only mount is a normal state, not an
 * error.
 */
export interface FileCapabilities {
  upload: boolean;
  createDirectory: boolean;
  rename: boolean;
  remove: boolean;
}

/** Which workspace a request is about. */
export interface FileTargetInfo {
  /** The token the client sends back, e.g. `user` or `council:<id>`. */
  id: string;
  /** Human label for the header, e.g. the council's name. */
  label: string;
  /** Absolute path of the workspace root. */
  root: string;
  capabilities: FileCapabilities;
}

/** A directory listing plus the context needed to render a header. */
export interface FileListing {
  target: FileTargetInfo;
  path: string;
  entries: FileEntry[];
  /** True when the directory held more rows than the listing limit. */
  truncated: boolean;
}

/** Bytes plus the type to serve them as. */
export interface FileBytes {
  // ArrayBuffer-backed so the bytes can be handed straight to a Response body.
  buffer: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/** What a provider reports for one path. */
export interface FileStat {
  kind: FileKind;
  size: number;
  modified: number;
  writable: boolean;
}

/** Every capability enabled. the shape of a normal, writable workspace. */
export const FULL_CAPABILITIES: FileCapabilities = {
  upload: true,
  createDirectory: true,
  rename: true,
  remove: true,
};
