// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilesPage } from './FilesPage';
import * as api from '../api/files';
vi.mock('../api/files', () => ({
  listFiles: vi.fn(),
  listArtifacts: vi.fn(),
  uploadFile: vi.fn(),
  previewFile: vi.fn(),
  previewArtifact: vi.fn(),
  extractFile: vi.fn(),
  deleteFile: vi.fn(),
  deleteArtifact: vi.fn(),
  getDownloadReference: vi.fn(),
}));
const mockFile: api.FileView = {
  id: 'file_1',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  declaredMimeType: 'text/plain',
  detectedType: 'txt',
  category: 'text',
  size: 18,
  checksum: 'a'.repeat(64),
  extensionMismatch: false,
  mimeMismatch: false,
  encoding: 'utf-8',
  lineCount: 1,
  language: null,
  width: null,
  height: null,
  durationSeconds: null,
  source: 'user_upload',
  status: 'ready',
  projectId: null,
  workspaceId: null,
  createdAt: '2026-09-22T10:00:00Z',
  expiresAt: null,
  parentFileId: null,
  sourceOperation: null,
};
const mockArtifact: api.ArtifactView = {
  id: 'artifact_1',
  type: 'derived_text',
  filename: 'result.json',
  mimeType: 'application/json',
  size: 32,
  checksum: 'b'.repeat(64),
  status: 'ready',
  projectId: null,
  workspaceId: null,
  sourceOperation: 'extract:file_1',
  provenance: {
    parentFileIds: ['file_1'],
    parentArtifactIds: [],
    operationId: 'extract:file_1',
    statement: 'Origin does not establish correctness.',
  },
  createdAt: '2026-09-22T10:00:00Z',
  expiresAt: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listFiles).mockResolvedValue([mockFile]);
  vi.mocked(api.listArtifacts).mockResolvedValue([mockArtifact]);
  vi.mocked(api.previewFile).mockResolvedValue({
    kind: 'text',
    text: '<script>untrusted</script>',
    mediaMimeType: null,
    entries: [],
    truncated: false,
    trust: 'untrusted_data',
  });
  vi.mocked(api.previewArtifact).mockResolvedValue({
    kind: 'text',
    text: '{}',
    mediaMimeType: null,
    entries: [],
    truncated: false,
    trust: 'untrusted_data',
  });
});
afterEach(cleanup);
describe('FilesPage', () => {
  it('lists files and previews untrusted HTML as text only', async () => {
    render(<FilesPage />);
    const file = await screen.findByRole('button', { name: /notes\.txt/ });
    fireEvent.click(file);
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(screen.getByText('<script>untrusted</script>').tagName).toBe('PRE');
    expect(document.querySelector('script[src="untrusted"]')).toBeNull();
  });
  it('shows provenance and a controlled artifact download action', async () => {
    vi.mocked(api.getDownloadReference).mockResolvedValue({
      downloadUrl: '/api/artifacts/artifact_1/download?token=opaque',
      expiresAt: '2026-09-22T10:05:00Z',
    });
    render(<FilesPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Artifacts/ }));
    expect(screen.getByText('result.json')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /result\.json/ }));
    expect(await screen.findByText(/Origin does not establish correctness/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDefined();
  });
  it('extracts only when explicitly requested', async () => {
    vi.mocked(api.extractFile).mockResolvedValue({ artifactIds: ['artifact_1'], childFileIds: [] });
    render(<FilesPage />);
    expect(await screen.findByText('notes.txt')).toBeDefined();
    expect(api.extractFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));
    await waitFor(() => expect(api.extractFile).toHaveBeenCalledWith('file_1'));
  });
  it('keeps empty states and search usable', async () => {
    vi.mocked(api.listFiles).mockResolvedValue([]);
    vi.mocked(api.listArtifacts).mockResolvedValue([]);
    render(<FilesPage />);
    expect(await screen.findByText(/No files yet/)).toBeDefined();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'report' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.listFiles).toHaveBeenCalledWith('report'));
  });
});
