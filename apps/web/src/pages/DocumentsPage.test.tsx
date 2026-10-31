// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DocumentsPage } from './DocumentsPage';
import { ApiError } from '../api/client';
import * as files from '../api/files';
import * as docs from '../api/documents';

vi.mock('../api/files', () => ({ listFiles: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../api/documents', () => ({
  getDocumentCapabilities: vi.fn(),
  inspectDocument: vi.fn(),
  processDocument: vi.fn(),
  getDocumentStructure: vi.fn(),
  searchDocument: vi.fn(),
  askDocument: vi.fn(),
  summarizeDocument: vi.fn(),
  extractDocumentEntities: vi.fn(),
  exportDocumentArtifact: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(files.listFiles).mockResolvedValue([
    { id: 'd1', filename: 'report.docx', size: 20480, category: 'document' } as files.FileView,
  ]);
  vi.mocked(docs.getDocumentCapabilities).mockResolvedValue({
    providerIsSimulation: true,
    capabilities: ['question_answering', 'summarization'],
  } as never);
  vi.mocked(docs.inspectDocument).mockResolvedValue({
    fileId: 'd1',
    format: 'docx',
    detectedFrom: 'magic-bytes',
    byteSize: 20480,
  } as never);
  vi.mocked(docs.processDocument).mockResolvedValue({
    jobId: 'job1',
    fileId: 'd1',
    status: 'completed',
    error: null,
  } as never);
  vi.mocked(docs.getDocumentStructure).mockResolvedValue({
    fileId: 'd1',
    format: 'docx',
    elements: [
      { id: 'e1', type: 'heading', text: 'Vision', ref: { kind: 'element', id: 'e1' } },
      {
        id: 'e2',
        type: 'paragraph',
        text: 'Own the messenger market.',
        ref: { kind: 'element', id: 'e2' },
      },
      {
        id: 'e3',
        type: 'paragraph',
        text: '<script>alert(1)</script>',
        ref: { kind: 'element', id: 'e3' },
      },
    ],
    tables: [],
    sections: [{ id: 's1', title: 'Vision', elementIds: ['e1', 'e2'] }],
    pageCount: null,
    slideCount: null,
    sheetCount: null,
    truncated: false,
    trustTag: 'untrusted_data',
  } as never);
});

afterEach(cleanup);

async function openDocument() {
  render(<DocumentsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /report.docx/ }));
  return docs;
}

describe('DocumentsPage', () => {
  it('declares that parsing is real while reasoning is simulated', async () => {
    render(<DocumentsPage />);
    expect(
      await screen.findByText(/Reasoning answers come from a deterministic simulation/),
    ).toBeDefined();
    expect(await screen.findByRole('button', { name: /report.docx/ })).toBeDefined();
  });

  it('inspects the selected file and shows the detected format', async () => {
    await openDocument();
    expect(await screen.findByText(/DOCX · 20.0 KB · detected from magic-bytes/)).toBeDefined();
  });

  it('renders extracted text without executing markup', async () => {
    const api = await openDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Process document/ }));
    expect(await screen.findByText('Own the messenger market.')).toBeDefined();
    expect(await screen.findByText('<script>alert(1)</script>')).toBeDefined();
    expect(document.querySelector('script')).toBeNull();
    expect(api.processDocument).toHaveBeenCalledWith('d1');
  });

  it('labels answers as AI-generated and shows verified evidence', async () => {
    const api = await openDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Process document/ }));
    await screen.findByText('Own the messenger market.');
    vi.mocked(api.askDocument).mockResolvedValue({
      fileId: 'd1',
      question: 'What is the goal?',
      answer: 'To own the messenger market.',
      confidence: 'medium',
      evidence: [{ quote: 'Own the messenger market.', ref: { kind: 'element', id: 'e2' } }],
      trustTag: 'ai_generated',
    } as never);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What is the goal?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('To own the messenger market.')).toBeDefined();
    expect(await screen.findByText(/Confidence: medium \(AI-generated\)/)).toBeDefined();
    expect(screen.getByText('Own the messenger market.')).toBeDefined();
  });

  it('reports honest empty search results', async () => {
    const api = await openDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Process document/ }));
    await screen.findByText('Own the messenger market.');
    vi.mocked(api.searchDocument).mockResolvedValue({
      fileId: 'd1',
      matches: [],
      total: 0,
      truncated: false,
      trustTag: 'untrusted_data',
    } as never);
    fireEvent.change(screen.getByLabelText('Find text'), { target: { value: 'zebra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No matches in the extracted text.')).toBeDefined();
  });

  it('surfaces a processing failure as an alert, not a silent dead end', async () => {
    const api = await openDocument();
    vi.mocked(api.processDocument).mockRejectedValue(
      new ApiError(409, 'Conflict', 'Document could not be parsed.'),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Process document/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Document could not be parsed.');
  });
});
