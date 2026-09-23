import { apiRequest } from './client';
export interface FileView {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly declaredMimeType: string | null;
  readonly detectedType: string;
  readonly category: string;
  readonly size: number;
  readonly checksum: string;
  readonly extensionMismatch: boolean;
  readonly mimeMismatch: boolean;
  readonly encoding: string | null;
  readonly lineCount: number | null;
  readonly language: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly source: string;
  readonly status: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly parentFileId: string | null;
  readonly sourceOperation: string | null;
}
export interface ArtifactView {
  readonly id: string;
  readonly type: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly checksum: string;
  readonly status: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly sourceOperation: string;
  readonly provenance: {
    readonly parentFileIds: readonly string[];
    readonly parentArtifactIds: readonly string[];
    readonly operationId: string;
    readonly statement: string;
  };
  readonly createdAt: string;
  readonly expiresAt: string | null;
}
export interface FilePreviewView {
  readonly kind: string;
  readonly text: string | null;
  readonly mediaMimeType: string | null;
  readonly entries: readonly {
    readonly path: string;
    readonly kind: string;
    readonly uncompressedSize: number;
    readonly detectedType: string;
  }[];
  readonly truncated: boolean;
  readonly trust: 'untrusted_data';
}
const encode = (value: string) => encodeURIComponent(value);
export async function listFiles(search = ''): Promise<readonly FileView[]> {
  const r = await apiRequest<{ files: FileView[] }>(
    `/api/files${search ? `?search=${encode(search)}` : ''}`,
  );
  return r.files;
}
export async function listArtifacts(search = ''): Promise<readonly ArtifactView[]> {
  const r = await apiRequest<{ artifacts: ArtifactView[] }>(
    `/api/artifacts${search ? `?search=${encode(search)}` : ''}`,
  );
  return r.artifacts;
}
export async function uploadFile(
  file: File,
  scope: { projectId: string | null; workspaceId: string | null },
): Promise<FileView> {
  if (file.size > 25 * 1024 * 1024)
    throw new Error('File exceeds the 25 MB development upload limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return apiRequest<FileView>('/api/files', {
    method: 'POST',
    body: {
      filename: file.name,
      contentBase64: btoa(binary),
      mimeType: file.type || undefined,
      source: 'user_upload',
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
    },
  });
}
export const getFile = (id: string) => apiRequest<FileView>(`/api/files/${encode(id)}`);
export const previewFile = (id: string) =>
  apiRequest<FilePreviewView>(`/api/files/${encode(id)}/preview`);
export const extractFile = (id: string) =>
  apiRequest<{ artifactIds: string[]; childFileIds: string[] }>(
    `/api/files/${encode(id)}/extract`,
    { method: 'POST' },
  );
export const deleteFile = (id: string) =>
  apiRequest<void>(`/api/files/${encode(id)}`, { method: 'DELETE' });
export const getArtifact = (id: string) => apiRequest<ArtifactView>(`/api/artifacts/${encode(id)}`);
export const previewArtifact = (id: string) =>
  apiRequest<FilePreviewView>(`/api/artifacts/${encode(id)}/preview`);
export const getDownloadReference = (id: string) =>
  apiRequest<{ downloadUrl: string; expiresAt: string }>(`/api/artifacts/${encode(id)}/download`);
export const deleteArtifact = (id: string) =>
  apiRequest<void>(`/api/artifacts/${encode(id)}`, { method: 'DELETE' });
