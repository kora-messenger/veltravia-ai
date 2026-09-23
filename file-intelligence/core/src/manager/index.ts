import { createHash, timingSafeEqual } from 'node:crypto';
import type { FileAssetStore } from '../store/index.js';
import type { FileAuditEventType, FileAuditSink } from '../audit/index.js';
import { scrubAuditMetadata } from '../audit/index.js';
import { detectFile } from '../detection/index.js';
import { detectArchiveChild, extractFile, inspectZip } from '../extraction/index.js';
import { FileAuthorizationError, FileIntelligenceError } from '../errors/index.js';
import {
  asArtifactId,
  asFileAssetId,
  type Artifact,
  type ArtifactId,
  type CreateArtifactInput,
  type DownloadReference,
  type FileAsset,
  type FileAssetId,
  type FileExtractionResult,
  type FileLimits,
  type FilePreview,
  type FilePrincipal,
  type FileScope,
  type RegisterFileInput,
} from '../types/index.js';
import {
  assertFileTransition,
  authorizeScope,
  scrubSecrets,
  newId,
  normalizeFilename,
  resolveFileLimits,
  safeDownloadFilename,
  sha256,
} from '../security/index.js';

export interface ScopeValidator {
  validate(scope: FileScope): Promise<void>;
}
export interface ProjectArtifactPublisher {
  publish(input: {
    artifact: Artifact;
    bytes: Uint8Array;
    projectId: string;
    workspaceId: string;
    path: string;
  }): Promise<{ revisionId: string | null }>;
}
export interface FileIntelligenceOptions {
  readonly store: FileAssetStore;
  readonly limits?: Partial<FileLimits>;
  readonly now?: () => Date;
  readonly onAudit?: FileAuditSink;
  readonly scopeValidator?: ScopeValidator;
  readonly publisher?: ProjectArtifactPublisher;
  readonly downloadTtlSeconds?: number;
}
interface DownloadRecord {
  readonly tokenHash: string;
  readonly artifactId: ArtifactId;
  readonly principalOwnerRef: string;
  readonly expiresAt: string;
}
export class FileIntelligenceManager {
  readonly limits: FileLimits;
  private readonly now: () => Date;
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly extraction = new Map<FileAssetId, FileExtractionResult>();
  constructor(private readonly options: FileIntelligenceOptions) {
    this.limits = resolveFileLimits(options.limits);
    this.now = options.now ?? (() => new Date());
  }
  private audit(
    type: FileAuditEventType,
    scope: FileScope,
    fileId: string | null,
    artifactId: string | null,
    metadata: Record<string, string | number | boolean | null> = {},
  ) {
    this.options.onAudit?.({
      type,
      at: this.now().toISOString(),
      ownerRef: scope.ownerRef,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      fileId,
      artifactId,
      metadata: scrubAuditMetadata(metadata),
    });
  }
  private async scope(scope: FileScope) {
    if (!scope.ownerRef)
      throw new FileIntelligenceError('FILE_INVALID_REQUEST', 'Owner scope is required.');
    if (scope.workspaceId && !scope.projectId)
      throw new FileIntelligenceError(
        'FILE_INVALID_REQUEST',
        'Workspace-scoped files require a project.',
      );
    await this.options.scopeValidator?.validate(scope);
  }
  private async requireFile(
    id: FileAssetId,
    principal: FilePrincipal,
    allowTerminal = false,
  ): Promise<FileAsset> {
    const asset = await this.options.store.getFile(id);
    if (!asset) throw new FileIntelligenceError('FILE_NOT_FOUND', 'File was not found.');
    try {
      authorizeScope(principal, asset.scope);
    } catch (e) {
      this.audit('authorization_denied', asset.scope, id, null);
      throw e;
    }
    if (!allowTerminal && asset.status === 'deleted')
      throw new FileIntelligenceError('FILE_DELETED', 'File was deleted.');
    if (
      !allowTerminal &&
      (asset.status === 'expired' ||
        (asset.expiresAt && Date.parse(asset.expiresAt) <= this.now().getTime()))
    )
      throw new FileIntelligenceError('FILE_EXPIRED', 'File has expired.');
    return asset;
  }
  private async requireArtifact(
    id: ArtifactId,
    principal: FilePrincipal,
    allowTerminal = false,
  ): Promise<Artifact> {
    const a = await this.options.store.getArtifact(id);
    if (!a) throw new FileIntelligenceError('ARTIFACT_NOT_FOUND', 'Artifact was not found.');
    try {
      authorizeScope(principal, a.scope);
    } catch (e) {
      this.audit('authorization_denied', a.scope, null, id);
      throw e;
    }
    if (!allowTerminal && a.status === 'deleted')
      throw new FileIntelligenceError('ARTIFACT_NOT_FOUND', 'Artifact was not found.');
    if (
      !allowTerminal &&
      (a.status === 'expired' || (a.expiresAt && Date.parse(a.expiresAt) <= this.now().getTime()))
    )
      throw new FileIntelligenceError('ARTIFACT_EXPIRED', 'Artifact has expired.');
    return a;
  }
  private async transition(asset: FileAsset, status: FileAsset['status']): Promise<FileAsset> {
    assertFileTransition(asset.status, status);
    const next = { ...asset, status, updatedAt: this.now().toISOString() };
    await this.options.store.updateFile(next);
    return next;
  }
  async registerFile(input: RegisterFileInput): Promise<FileAsset> {
    await this.scope(input.scope);
    if (input.bytes.length > this.limits.maxSingleFileBytes)
      throw new FileIntelligenceError(
        'FILE_TOO_LARGE',
        'File exceeds the configured single-file limit.',
        { bytes: input.bytes.length, limit: this.limits.maxSingleFileBytes },
      );
    const filename = normalizeFilename(input.filename, this.limits.maxPathLength);
    const now = this.now().toISOString();
    const id = asFileAssetId(newId('file'));
    const preliminary = await detectFile(filename, input.declaredMimeType ?? null, input.bytes);
    const ref = {
      storageKey: `mock-file:${id}`,
      byteLength: input.bytes.length,
      checksum: preliminary.metadata.checksum,
    };
    let asset: FileAsset = {
      id,
      metadata: preliminary.metadata,
      source: input.source,
      scope: input.scope,
      status: 'received',
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
      parentFileId: input.parentFileId ?? null,
      parentArtifactId: input.parentArtifactId ?? null,
      sourceOperation: input.sourceOperation ?? null,
      content: ref,
    };
    await this.options.store.putFile(asset, input.bytes);
    this.audit('file_uploaded', input.scope, id, null, {
      bytes: input.bytes.length,
      type: preliminary.metadata.detectedType,
    });
    asset = await this.transition(asset, 'validating');
    try {
      if (!preliminary.validation.valid)
        throw new FileIntelligenceError(
          'FILE_TYPE_REJECTED',
          'File type could not be safely identified.',
        );
      if (['zip', 'docx', 'xlsx'].includes(preliminary.metadata.detectedType)) {
        const checked = await inspectZip(input.bytes, this.limits);
        if (
          preliminary.metadata.detectedType === 'docx' &&
          !checked.entries.some((e) => e.path === 'word/document.xml')
        )
          throw new FileIntelligenceError(
            'FILE_TYPE_REJECTED',
            'DOCX document structure is invalid.',
          );
        if (
          preliminary.metadata.detectedType === 'xlsx' &&
          !checked.entries.some((e) => e.path === 'xl/workbook.xml')
        )
          throw new FileIntelligenceError(
            'FILE_TYPE_REJECTED',
            'XLSX workbook structure is invalid.',
          );
      }
      asset = await this.transition(asset, 'validated');
      asset = await this.transition(asset, 'ready');
      this.audit('validation_passed', input.scope, id, null, {
        type: asset.metadata.detectedType,
        mimeMismatch: asset.metadata.mimeMismatch,
        extensionMismatch: asset.metadata.extensionMismatch,
      });
      return asset;
    } catch (error) {
      await this.transition(asset, 'rejected');
      this.audit(
        error instanceof FileIntelligenceError && error.code === 'FILE_ARCHIVE_REJECTED'
          ? 'archive_rejected'
          : 'validation_failed',
        input.scope,
        id,
        null,
        { reason: error instanceof FileIntelligenceError ? error.code : 'invalid' },
      );
      throw error;
    }
  }
  async listFiles(
    principal: FilePrincipal,
    filter: {
      projectId?: string | null;
      workspaceId?: string | null;
      type?: string;
      status?: string;
      search?: string;
    } = {},
  ): Promise<readonly FileAsset[]> {
    const all = await this.options.store.listFiles();
    return all
      .filter((a) => {
        try {
          authorizeScope(principal, a.scope);
        } catch {
          return false;
        }
        return (
          a.status !== 'deleted' &&
          (filter.projectId === undefined || a.scope.projectId === filter.projectId) &&
          (filter.workspaceId === undefined || a.scope.workspaceId === filter.workspaceId) &&
          (!filter.type || a.metadata.detectedType === filter.type) &&
          (!filter.status || a.status === filter.status) &&
          (!filter.search ||
            a.metadata.normalizedFilename.toLowerCase().includes(filter.search.toLowerCase()))
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getFile(id: FileAssetId, principal: FilePrincipal): Promise<FileAsset> {
    return this.requireFile(id, principal);
  }
  async getChildren(id: FileAssetId, principal: FilePrincipal): Promise<readonly FileAsset[]> {
    const parent = await this.requireFile(id, principal);
    const all = await this.options.store.listFiles();
    return all.filter((a) => a.parentFileId === parent.id && a.status !== 'deleted');
  }
  async extract(id: FileAssetId, principal: FilePrincipal): Promise<FileExtractionResult> {
    const cached = this.extraction.get(id);
    if (cached) {
      await this.requireFile(id, principal);
      return cached;
    }
    let asset = await this.requireFile(id, principal);
    if (!['ready', 'derived'].includes(asset.status))
      throw new FileIntelligenceError(
        'FILE_INVALID_TRANSITION',
        'File is not ready for extraction.',
      );
    const bytes = await this.options.store.getFileBytes(id);
    if (!bytes)
      throw new FileIntelligenceError(
        'FILE_INTEGRITY_FAILURE',
        'Stored file bytes are unavailable.',
      );
    if (sha256(bytes) !== asset.content.checksum) {
      this.audit('integrity_failure', asset.scope, id, null);
      throw new FileIntelligenceError(
        'FILE_INTEGRITY_FAILURE',
        'Stored file integrity check failed.',
      );
    }
    asset = await this.transition(asset, 'extracting');
    this.audit('extraction_requested', asset.scope, id, null, {
      type: asset.metadata.detectedType,
    });
    try {
      const out = await extractFile(
        asset.metadata,
        bytes,
        this.limits,
        asset.metadata.detectedType === 'zip',
      );
      const childIds: FileAssetId[] = [];
      for (const child of out.archiveFiles) {
        const detected = await detectArchiveChild(
          child.path.split('/').pop() ?? 'file',
          child.bytes,
        );
        if (detected.metadata.detectedType === 'unknown') continue;
        const childAsset = await this.registerFile({
          filename: child.path.split('/').pop() ?? 'file',
          bytes: child.bytes,
          source: 'derived_extraction',
          scope: asset.scope,
          parentFileId: asset.id,
          sourceOperation: `extract:${asset.id}`,
        });
        childIds.push(childAsset.id);
      }
      const previewText =
        'text' in out.representation
          ? out.representation.text
          : out.representation.kind === 'json'
            ? out.representation.textPreview
            : out.representation.kind === 'xml'
              ? out.representation.textPreview
              : JSON.stringify(out.representation);
      const artifact = await this.createArtifact({
        type:
          asset.metadata.detectedType === 'csv'
            ? 'transformed_csv'
            : asset.metadata.detectedType === 'json'
              ? 'generated_json'
              : asset.metadata.detectedType === 'zip'
                ? 'report'
                : 'derived_text',
        filename: `${asset.metadata.normalizedFilename}.extraction.json`,
        mimeType: 'application/json',
        bytes: Buffer.from(JSON.stringify(out.representation)),
        scope: asset.scope,
        sourceOperation: `extract:${asset.id}`,
        parentFileIds: [asset.id],
      });
      const result: FileExtractionResult = {
        fileId: id,
        representation: out.representation,
        childFileIds: childIds,
        artifactIds: [artifact.id],
      };
      this.extraction.set(id, result);
      await this.transition(asset, childIds.length > 0 ? 'derived' : 'ready');
      this.audit('extraction_completed', asset.scope, id, artifact.id, {
        children: childIds.length,
        previewCharacters: previewText.length,
      });
      return result;
    } catch (error) {
      await this.transition(asset, 'rejected').catch(() => undefined);
      this.audit('extraction_failed', asset.scope, id, null, {
        reason: error instanceof FileIntelligenceError ? error.code : 'failed',
      });
      throw error;
    }
  }
  async preview(id: FileAssetId, principal: FilePrincipal): Promise<FilePreview> {
    const asset = await this.requireFile(id, principal);
    const bytes = await this.options.store.getFileBytes(id);
    if (!bytes || sha256(bytes) !== asset.content.checksum)
      throw new FileIntelligenceError('FILE_INTEGRITY_FAILURE', 'File integrity check failed.');
    if (asset.metadata.category === 'image')
      return {
        fileId: id,
        kind: 'image',
        text: null,
        mediaMimeType: asset.metadata.detectedMimeType,
        entries: [],
        truncated: false,
        trust: 'untrusted_data',
      };
    if (asset.metadata.category === 'audio' || asset.metadata.category === 'video')
      return {
        fileId: id,
        kind: 'metadata',
        text: null,
        mediaMimeType: null,
        entries: [],
        truncated: false,
        trust: 'untrusted_data',
      };
    const out = await extractFile(asset.metadata, bytes, this.limits, false);
    const r = out.representation;
    if (r.kind === 'archive')
      return {
        fileId: id,
        kind: 'archive',
        text: null,
        mediaMimeType: null,
        entries: r.entries,
        truncated: r.truncated,
        trust: 'untrusted_data',
      };
    const raw =
      'text' in r
        ? r.text
        : r.kind === 'json' || r.kind === 'xml'
          ? r.textPreview
          : JSON.stringify(r);
    const text = scrubSecrets(raw.slice(0, this.limits.maxPreviewCharacters));
    return {
      fileId: id,
      kind: asset.metadata.category === 'document' ? 'document' : 'text',
      text,
      mediaMimeType: null,
      entries: [],
      truncated: raw.length > this.limits.maxPreviewCharacters || ('truncated' in r && r.truncated),
      trust: 'untrusted_data',
    };
  }
  async imageBytes(
    id: FileAssetId,
    principal: FilePrincipal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const asset = await this.requireFile(id, principal);
    if (asset.metadata.category !== 'image')
      throw new FileIntelligenceError('FILE_TYPE_REJECTED', 'File is not an image.');
    const bytes = await this.options.store.getFileBytes(id);
    if (
      !bytes ||
      bytes.length !== asset.metadata.byteSize ||
      sha256(bytes) !== asset.metadata.checksum
    )
      throw new FileIntelligenceError('FILE_INTEGRITY_FAILURE', 'Image integrity check failed.');
    return { bytes, mimeType: asset.metadata.detectedMimeType };
  }
  async deleteFile(id: FileAssetId, principal: FilePrincipal): Promise<void> {
    const asset = await this.requireFile(id, principal);
    await this.transition(asset, 'deleted');
    this.audit('file_deleted', asset.scope, id, null);
  }
  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    await this.scope(input.scope);
    if (input.bytes.length > this.limits.maxArtifactBytesPerOperation)
      throw new FileIntelligenceError(
        'FILE_LIMIT_EXCEEDED',
        'Artifact exceeds the operation storage limit.',
      );
    const filename = normalizeFilename(input.filename, this.limits.maxPathLength);
    const now = this.now().toISOString();
    const id = asArtifactId(newId('artifact'));
    const checksum = sha256(input.bytes);
    let artifact: Artifact = {
      id,
      type: input.type,
      metadata: { filename, mimeType: input.mimeType, byteSize: input.bytes.length, checksum },
      scope: input.scope,
      status: 'creating',
      sourceOperation: input.sourceOperation,
      provenance: {
        parentFileIds: input.parentFileIds ?? [],
        parentArtifactIds: input.parentArtifactIds ?? [],
        operationId: input.sourceOperation,
        statement:
          'Provenance records origin only; it does not establish correctness or authority.',
      },
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
      reference: { storageKey: `mock-artifact:${id}`, byteLength: input.bytes.length, checksum },
    };
    await this.options.store.putArtifact(artifact, input.bytes);
    artifact = { ...artifact, status: 'validating', updatedAt: this.now().toISOString() };
    await this.options.store.updateArtifact(artifact);
    const stored = await this.options.store.getArtifactBytes(id);
    if (!stored || stored.length !== input.bytes.length || sha256(stored) !== checksum) {
      artifact = { ...artifact, status: 'corrupted', updatedAt: this.now().toISOString() };
      await this.options.store.updateArtifact(artifact);
      throw new FileIntelligenceError(
        'ARTIFACT_INTEGRITY_FAILURE',
        'Artifact failed integrity validation.',
      );
    }
    artifact = { ...artifact, status: 'ready', updatedAt: this.now().toISOString() };
    await this.options.store.updateArtifact(artifact);
    this.audit('artifact_created', artifact.scope, null, id, {
      bytes: input.bytes.length,
      type: input.type,
    });
    return artifact;
  }
  async listArtifacts(
    principal: FilePrincipal,
    filter: { projectId?: string | null; workspaceId?: string | null; search?: string } = {},
  ): Promise<readonly Artifact[]> {
    const all = await this.options.store.listArtifacts();
    return all
      .filter((a) => {
        try {
          authorizeScope(principal, a.scope);
        } catch {
          return false;
        }
        return (
          a.status !== 'deleted' &&
          (filter.projectId === undefined || a.scope.projectId === filter.projectId) &&
          (filter.workspaceId === undefined || a.scope.workspaceId === filter.workspaceId) &&
          (!filter.search ||
            a.metadata.filename.toLowerCase().includes(filter.search.toLowerCase()))
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getArtifact(id: ArtifactId, principal: FilePrincipal): Promise<Artifact> {
    return this.requireArtifact(id, principal);
  }
  async artifactPreview(id: ArtifactId, principal: FilePrincipal): Promise<FilePreview> {
    const artifact = await this.requireArtifact(id, principal);
    const bytes = await this.options.store.getArtifactBytes(id);
    if (!bytes)
      throw new FileIntelligenceError(
        'ARTIFACT_INTEGRITY_FAILURE',
        'Artifact bytes are unavailable.',
      );
    const textual = /^(text\/|application\/(json|xml))/.test(artifact.metadata.mimeType);
    return {
      fileId: asFileAssetId(`artifact-preview:${id}`),
      kind: textual ? 'text' : 'metadata',
      text: textual
        ? scrubSecrets(
            Buffer.from(bytes).toString('utf8').slice(0, this.limits.maxPreviewCharacters),
          )
        : null,
      mediaMimeType: artifact.metadata.mimeType.startsWith('image/')
        ? artifact.metadata.mimeType
        : null,
      entries: [],
      truncated: textual && bytes.length > this.limits.maxPreviewCharacters,
      trust: 'untrusted_data',
    };
  }
  async createDownloadReference(
    id: ArtifactId,
    principal: FilePrincipal,
  ): Promise<DownloadReference> {
    const artifact = await this.requireArtifact(id, principal);
    if (artifact.status !== 'ready')
      throw new FileIntelligenceError('ARTIFACT_NOT_READY', 'Artifact is not ready to download.');
    const token = newId('download');
    const expiresAt = new Date(
      this.now().getTime() + (this.options.downloadTtlSeconds ?? 300) * 1000,
    ).toISOString();
    this.downloads.set(token, {
      tokenHash: createHash('sha256').update(token).digest('hex'),
      artifactId: id,
      principalOwnerRef: principal.ownerRef,
      expiresAt,
    });
    return { token, artifactId: id, expiresAt };
  }
  async resolveDownload(
    id: ArtifactId,
    token: string,
    principal: FilePrincipal,
  ): Promise<{ artifact: Artifact; bytes: Uint8Array; filename: string }> {
    const record = this.downloads.get(token);
    if (
      !record ||
      record.artifactId !== id ||
      record.principalOwnerRef !== principal.ownerRef ||
      Date.parse(record.expiresAt) <= this.now().getTime()
    )
      throw new FileAuthorizationError();
    const expected = Buffer.from(record.tokenHash, 'hex'),
      actual = Buffer.from(createHash('sha256').update(token).digest('hex'), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new FileAuthorizationError();
    const artifact = await this.requireArtifact(id, principal);
    const bytes = await this.options.store.getArtifactBytes(id);
    if (
      !bytes ||
      bytes.length !== artifact.metadata.byteSize ||
      sha256(bytes) !== artifact.metadata.checksum
    ) {
      this.audit('integrity_failure', artifact.scope, null, id);
      throw new FileIntelligenceError(
        'ARTIFACT_INTEGRITY_FAILURE',
        'Artifact download integrity check failed.',
      );
    }
    this.audit('artifact_downloaded', artifact.scope, null, id, { bytes: bytes.length });
    return { artifact, bytes, filename: safeDownloadFilename(artifact.metadata.filename) };
  }
  async deleteArtifact(id: ArtifactId, principal: FilePrincipal): Promise<void> {
    const a = await this.requireArtifact(id, principal);
    await this.options.store.updateArtifact({
      ...a,
      status: 'deleted',
      updatedAt: this.now().toISOString(),
    });
    this.audit('artifact_deleted', a.scope, null, id);
  }
  async publishArtifact(
    id: ArtifactId,
    principal: FilePrincipal,
    path: string,
  ): Promise<{ revisionId: string | null }> {
    const artifact = await this.requireArtifact(id, principal);
    if (!artifact.scope.projectId || !artifact.scope.workspaceId || !this.options.publisher)
      throw new FileIntelligenceError(
        'FILE_INVALID_REQUEST',
        'Artifact is not publishable to a workspace.',
      );
    const bytes = await this.options.store.getArtifactBytes(id);
    if (
      !bytes ||
      bytes.length !== artifact.metadata.byteSize ||
      sha256(bytes) !== artifact.metadata.checksum
    )
      throw new FileIntelligenceError(
        'ARTIFACT_INTEGRITY_FAILURE',
        'Artifact integrity check failed.',
      );
    return this.options.publisher.publish({
      artifact,
      bytes,
      projectId: artifact.scope.projectId,
      workspaceId: artifact.scope.workspaceId,
      path,
    });
  }
}
