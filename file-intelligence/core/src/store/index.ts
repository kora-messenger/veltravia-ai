import type { Artifact, ArtifactId, FileAsset, FileAssetId } from '../types/index.js';
export interface FileAssetStore {
  putFile(asset: FileAsset, bytes: Uint8Array): Promise<void>;
  getFile(id: FileAssetId): Promise<FileAsset | null>;
  getFileBytes(id: FileAssetId): Promise<Uint8Array | null>;
  updateFile(asset: FileAsset): Promise<void>;
  listFiles(): Promise<readonly FileAsset[]>;
  putArtifact(artifact: Artifact, bytes: Uint8Array): Promise<void>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  getArtifactBytes(id: ArtifactId): Promise<Uint8Array | null>;
  updateArtifact(artifact: Artifact): Promise<void>;
  listArtifacts(): Promise<readonly Artifact[]>;
}
