// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AudioPage } from './AudioPage';
import * as filesApi from '../api/files';
import * as audioApi from '../api/audio';

vi.mock('../api/files', () => ({
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
  getDownloadReference: vi.fn(),
}));
vi.mock('../api/audio', () => ({
  getAudioCapabilities: vi.fn(),
  listAudioJobs: vi.fn(),
  getAudioJob: vi.fn(),
  cancelAudioJob: vi.fn(),
  processAudio: vi.fn(),
  inspectAudio: vi.fn(),
  getAudioTranscript: vi.fn(),
  getAudioAnalysis: vi.fn(),
  queryAudio: vi.fn(),
  searchAudio: vi.fn(),
  summarizeAudio: vi.fn(),
  extractAudio: vi.fn(),
  translateAudio: vi.fn(),
  saveAudioArtifact: vi.fn(),
  audioMediaUrl: vi.fn((id: string) => `/api/audio/${id}/media`),
  createAudioMemoryCandidates: vi.fn(),
}));

const audioFile: Partial<filesApi.FileView> = {
  id: 'file_audio1',
  filename: 'meeting.wav',
  mimeType: 'audio/wav',
  detectedType: 'wav',
  category: 'audio',
  size: 16044,
  durationSeconds: 1,
  status: 'ready',
};
const capabilities: audioApi.AudioCapabilitiesView = {
  provider: { providerId: 'mock.audio', capabilities: ['transcription'], supportedFormats: null },
  providerIsSimulation: true,
  limits: {
    maxFileBytes: 25 * 1024 * 1024,
    maxDurationSeconds: 5400,
    maxChunks: 16,
    maxConcurrentJobs: 1,
  },
};
const job: audioApi.AudioJobView = {
  id: 'job_1',
  fileId: 'file_audio1',
  status: 'completed',
  stage: 'done',
  requestedLanguage: null,
  detectedLanguage: 'en',
  projectId: null,
  workspaceId: null,
  chunks: 1,
  completedChunks: 1,
  error: null,
  createdAt: '2026-09-28T08:00:00Z',
  updatedAt: '2026-09-28T08:00:00Z',
  expiresAt: '2026-09-29T08:00:00Z',
};
const transcript: audioApi.AudioTranscriptView = {
  fileId: 'file_audio1',
  language: 'en',
  languageAutoDetected: true,
  providerId: 'mock.audio',
  providerIsSimulation: true,
  timestampsAvailable: true,
  speakersAvailable: true,
  confidence: 0.9,
  chunkCount: 1,
  segments: [
    {
      id: 'seg_1',
      startSeconds: 0,
      endSeconds: 4,
      speaker: 'Speaker 1',
      confidence: 0.9,
      text: 'We should issue the refund by Friday.',
    },
  ],
  text: 'We should issue the refund by Friday.',
  trust: 'untrusted_data',
};

beforeEach(() => {
  vi.mocked(filesApi.listFiles).mockResolvedValue([audioFile as filesApi.FileView]);
  vi.mocked(filesApi.uploadFile).mockResolvedValue(audioFile as filesApi.FileView);
  vi.mocked(audioApi.getAudioCapabilities).mockResolvedValue(capabilities);
  vi.mocked(audioApi.getAudioTranscript).mockResolvedValue(transcript);
  vi.mocked(audioApi.processAudio).mockResolvedValue(job);
  vi.mocked(audioApi.getAudioJob).mockResolvedValue(job);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AudioPage', () => {
  it('discloses the simulation provider honestly', async () => {
    render(<AudioPage />);
    await waitFor(() => screen.findByText(/meeting\.wav/));
    expect(screen.getByText(/deterministic mock simulation/i)).toBeDefined();
  });
  it('lists audio files and renders the transcript with trust labels', async () => {
    render(<AudioPage />);
    const button = await screen.findByText(/meeting\.wav/);
    fireEvent.click(button);
    await waitFor(() => screen.findByText('Transcript'));
    expect(screen.getByText('untrusted data')).toBeDefined();
    expect(screen.getByText('We should issue the refund by Friday.')).toBeDefined();
    expect(screen.getByText('Speaker 1')).toBeDefined();
  });
  it('uploads an audio file through the Step 19 path with scope ids', async () => {
    render(<AudioPage />);
    const projectId = await screen.findByLabelText('Project id');
    fireEvent.change(projectId, { target: { value: 'prj_1' } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array(4)], 'voice.wav', { type: 'audio/wav' })],
    });
    fireEvent.change(input);
    await waitFor(() => expect(filesApi.uploadFile).toHaveBeenCalled());
    const call = vi.mocked(filesApi.uploadFile).mock.calls[0];
    expect(call[1]).toEqual({ projectId: 'prj_1', workspaceId: null });
  });
  it('processes the selected file and polls the job', async () => {
    render(<AudioPage />);
    fireEvent.click(await screen.findByText(/meeting\.wav/));
    const process = await screen.findByText('Process audio');
    fireEvent.click(process);
    await waitFor(() =>
      expect(audioApi.processAudio).toHaveBeenCalledWith('file_audio1', undefined),
    );
    await waitFor(() => expect(screen.findByText(/Job completed/)).toBeTruthy());
  });
  it('shows an honest error state when the API fails', async () => {
    vi.mocked(audioApi.getAudioCapabilities).mockRejectedValue(new Error('API down'));
    vi.mocked(filesApi.listFiles).mockRejectedValue(new Error('API down'));
    render(<AudioPage />);
    await waitFor(() => screen.findByText('Something went wrong. Please try again.'));
    expect(screen.queryByText(/Transcript/)).toBeNull();
  });
});
