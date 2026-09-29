// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImagePage } from './ImagePage';
import * as filesApi from '../api/files';
import * as imageApi from '../api/image';

vi.mock('../api/files', () => ({
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
  getDownloadReference: vi.fn(),
}));
vi.mock('../api/image', () => ({
  getImageCapabilities: vi.fn(),
  listImageJobs: vi.fn(),
  getImageJob: vi.fn(),
  cancelImageJob: vi.fn(),
  processImage: vi.fn(),
  inspectImage: vi.fn(),
  getImageAnalysis: vi.fn(),
  queryImage: vi.fn(),
  analyzeScreenshot: vi.fn(),
  getUiStructure: vi.fn(),
  analyzeChart: vi.fn(),
  analyzeDiagram: vi.fn(),
  extractImageFields: vi.fn(),
  compareImages: vi.fn(),
  searchImage: vi.fn(),
  searchAllImages: vi.fn(),
  saveImageArtifact: vi.fn(),
  imageMediaUrl: vi.fn((id: string) => `/api/image/${id}/media`),
}));

const imageFile: Partial<filesApi.FileView> = {
  id: 'file_image1',
  filename: 'app.png',
  mimeType: 'image/png',
  detectedType: 'png',
  category: 'image',
  size: 83,
  status: 'ready',
};
const capabilities: imageApi.ImageCapabilitiesView = {
  providers: [
    {
      providerId: 'image.mock',
      capabilities: ['image_understanding', 'ocr'],
      supportedFormats: null,
      maxBytes: null,
      maxDimensionPixels: null,
    },
  ],
  providerIsSimulation: true,
  operations: ['describe', 'ocr'],
  limits: {
    maxFileBytes: 10 * 1024 * 1024,
    maxDimensionPixels: 12_000,
    maxProcessingMs: 120_000,
    maxConcurrentJobs: 4,
    maxSearchMatches: 100,
    maxCompareImages: 4,
  },
};
const job: imageApi.ImageJobView = {
  id: 'imagejob_1',
  fileId: 'file_image1',
  status: 'completed',
  stage: 'done',
  projectId: null,
  workspaceId: null,
  operations: 2,
  completedOperations: 2,
  error: null,
  createdAt: '2026-09-29T08:00:00Z',
  updatedAt: '2026-09-29T08:00:00Z',
  expiresAt: '2026-09-30T08:00:00Z',
};
const analysis: imageApi.ImageAnalysisView = {
  description: {
    summary: 'A simple image with a purple block.',
    observed: ['a purple rectangle'],
    inferences: ['the image looks like a UI mock'],
    providerId: 'image.mock',
    trust: 'ai_generated',
  },
  ocr: {
    text: 'Veltravia Dashboard',
    regions: [{ id: 'r_1', text: 'Veltravia Dashboard', readingOrder: 1, confidence: 0.9 }],
    regionsAvailable: true,
    confidenceAvailable: true,
    providerId: 'image.mock',
    createdAt: '2026-09-29T08:00:00Z',
    trust: 'untrusted_data',
  },
  jobId: 'imagejob_1',
  providerIsSimulation: true,
};

beforeEach(() => {
  vi.mocked(filesApi.listFiles).mockResolvedValue([imageFile as filesApi.FileView]);
  vi.mocked(filesApi.uploadFile).mockResolvedValue(imageFile as filesApi.FileView);
  vi.mocked(imageApi.getImageCapabilities).mockResolvedValue(capabilities);
  vi.mocked(imageApi.getImageAnalysis).mockResolvedValue(analysis);
  vi.mocked(imageApi.processImage).mockResolvedValue(job);
  vi.mocked(imageApi.getImageJob).mockResolvedValue(job);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImagePage', () => {
  it('discloses the simulation provider honestly', async () => {
    render(<ImagePage />);
    await waitFor(() => screen.findByText(/app\.png/));
    expect(screen.getByText(/deterministic mock simulation/i)).toBeDefined();
  });

  it('lists image files and renders description + OCR with trust labels', async () => {
    render(<ImagePage />);
    fireEvent.click(await screen.findByText(/app\.png/));
    await waitFor(() => screen.findByText(/Description \(AI-generated\)/));
    expect(screen.getByText('A simple image with a purple block.')).toBeDefined();
    await waitFor(() => screen.findByText('Extracted text (untrusted data)'));
    expect(
      (await screen.findAllByText(/untrusted_data|untrusted data/i)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Inferences \(AI guesses\)/)).toBeDefined();
  });

  it('uploads an image file through the Step 19 path with scope ids', async () => {
    render(<ImagePage />);
    const projectId = await screen.findByLabelText('Project id');
    fireEvent.change(projectId, { target: { value: 'prj_1' } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' })],
    });
    fireEvent.change(input);
    await waitFor(() => expect(filesApi.uploadFile).toHaveBeenCalled());
    const call = vi.mocked(filesApi.uploadFile).mock.calls[0];
    expect(call[1]).toEqual({ projectId: 'prj_1', workspaceId: null });
  });

  it('processes the selected file and polls the job', async () => {
    render(<ImagePage />);
    fireEvent.click(await screen.findByText(/app\.png/));
    const process = await screen.findByText('Process image');
    fireEvent.click(process);
    await waitFor(() => expect(imageApi.processImage).toHaveBeenCalledWith('file_image1'));
    await waitFor(() =>
      expect(screen.getByTestId('image-job-status').textContent).toContain('completed'),
    );
  });

  it('asks a question and labels the answer ai_generated', async () => {
    vi.mocked(imageApi.queryImage).mockResolvedValue({
      question: 'What is shown?',
      answer: 'A purple block.',
      insufficientEvidence: false,
      providerId: 'image.mock',
      providerIsSimulation: true,
      trust: 'ai_generated',
    });
    render(<ImagePage />);
    fireEvent.click(await screen.findByText(/app\.png/));
    const question = await screen.findByLabelText('Question');
    fireEvent.change(question, { target: { value: 'What is shown?' } });
    fireEvent.click(screen.getByText('Ask'));
    await waitFor(() =>
      expect(imageApi.queryImage).toHaveBeenCalledWith('file_image1', 'What is shown?'),
    );
    await waitFor(() => screen.findByText('A purple block.'));
    expect((await screen.findAllByText(/ai_generated/)).length).toBeGreaterThan(0);
  });

  it('shows an honest error state when the API fails', async () => {
    vi.mocked(imageApi.getImageCapabilities).mockRejectedValue(new Error('API down'));
    vi.mocked(filesApi.listFiles).mockRejectedValue(new Error('API down'));
    render(<ImagePage />);
    await waitFor(() => screen.findByText('Something went wrong. Please try again.'));
    expect(screen.queryByText(/Description/)).toBeNull();
  });
});
