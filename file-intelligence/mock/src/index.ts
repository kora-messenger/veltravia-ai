import type {
  Artifact,
  ArtifactId,
  FileAsset,
  FileAssetId,
  FileAssetStore,
} from '@veltravia/file-intelligence-core';
/** Deterministic process-local mock. Bytes never touch the host filesystem. Restarting loses everything. */
export class InMemoryFileAssetStore implements FileAssetStore {
  private readonly files = new Map<FileAssetId, FileAsset>();
  private readonly fileBytes = new Map<FileAssetId, Uint8Array>();
  private readonly artifacts = new Map<ArtifactId, Artifact>();
  private readonly artifactBytes = new Map<ArtifactId, Uint8Array>();
  async putFile(a: FileAsset, b: Uint8Array) {
    this.files.set(a.id, structuredClone(a));
    this.fileBytes.set(a.id, Uint8Array.from(b));
  }
  async getFile(id: FileAssetId) {
    const v = this.files.get(id);
    return v ? structuredClone(v) : null;
  }
  async getFileBytes(id: FileAssetId) {
    const v = this.fileBytes.get(id);
    return v ? Uint8Array.from(v) : null;
  }
  async updateFile(a: FileAsset) {
    if (!this.files.has(a.id)) throw new Error('file missing');
    this.files.set(a.id, structuredClone(a));
  }
  async listFiles() {
    return [...this.files.values()].map((v) => structuredClone(v));
  }
  async putArtifact(a: Artifact, b: Uint8Array) {
    this.artifacts.set(a.id, structuredClone(a));
    this.artifactBytes.set(a.id, Uint8Array.from(b));
  }
  async getArtifact(id: ArtifactId) {
    const v = this.artifacts.get(id);
    return v ? structuredClone(v) : null;
  }
  async getArtifactBytes(id: ArtifactId) {
    const v = this.artifactBytes.get(id);
    return v ? Uint8Array.from(v) : null;
  }
  async updateArtifact(a: Artifact) {
    if (!this.artifacts.has(a.id)) throw new Error('artifact missing');
    this.artifacts.set(a.id, structuredClone(a));
  }
  async listArtifacts() {
    return [...this.artifacts.values()].map((v) => structuredClone(v));
  }
  /** Test-only corruption seam, never exposed by the API. */
  corruptArtifact(id: ArtifactId, bytes: Uint8Array) {
    this.artifactBytes.set(id, Uint8Array.from(bytes));
  }
}
