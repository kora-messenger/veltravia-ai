import type { AICapability } from '@veltravia/ai-core';
import type { TaskCategory } from './types.js';

/**
 * What each task category actually requires.
 *
 * `required` is a hard gate: a model that has not declared the capability is
 * never offered for that category. `preferred` only shapes the ranking, so a
 * missing preference is reported rather than hidden. `note` explains to a person
 * what the category means, and `structuralGap` marks a category no adapter can
 * serve yet - the router reports it as unsupported instead of pretending.
 */
export interface TaskRequirement {
  readonly category: TaskCategory;
  readonly displayName: string;
  readonly description: string;
  readonly required: readonly AICapability[];
  readonly preferred: readonly AICapability[];
  /**
   * Set when the platform has no adapter that can carry this task today. The
   * router refuses the category with this sentence rather than inventing a fit.
   */
  readonly structuralGap?: string;
}

export const TASK_REQUIREMENTS: Readonly<Record<TaskCategory, TaskRequirement>> = {
  'general-conversation': {
    category: 'general-conversation',
    displayName: 'General conversation',
    description: 'Everyday questions and drafting, with no special input format.',
    required: ['text-generation'],
    preferred: ['streaming'],
  },
  'complex-reasoning': {
    category: 'complex-reasoning',
    displayName: 'Complex reasoning',
    description: 'Multi-step analysis where the model has to hold a lot of context and argue.',
    required: ['text-generation'],
    preferred: ['large-context', 'structured-output', 'streaming'],
  },
  coding: {
    category: 'coding',
    displayName: 'Coding',
    description: 'Writing, explaining or reviewing source code.',
    required: ['text-generation'],
    preferred: ['code-generation', 'structured-output', 'streaming', 'large-context'],
  },
  'document-analysis': {
    category: 'document-analysis',
    displayName: 'Document analysis',
    description: 'Reading long documents and answering from them.',
    required: ['text-generation'],
    preferred: ['large-context', 'structured-output'],
  },
  'cross-source-intelligence': {
    category: 'cross-source-intelligence',
    displayName: 'Cross-source intelligence',
    description: 'Comparing evidence across documents, connected apps and workspace files.',
    required: ['text-generation'],
    preferred: ['large-context', 'structured-output'],
  },
  'web-research': {
    category: 'web-research',
    displayName: 'Web research',
    description: 'Summarising fetched pages and citing what was actually read.',
    required: ['text-generation'],
    preferred: ['large-context', 'streaming'],
  },
  'structured-data-extraction': {
    category: 'structured-data-extraction',
    displayName: 'Structured data extraction',
    description: 'Returning typed fields rather than prose.',
    required: ['text-generation', 'structured-output'],
    preferred: [],
  },
  'image-understanding': {
    category: 'image-understanding',
    displayName: 'Image understanding',
    description: 'Reading text and content out of an image.',
    required: ['vision'],
    preferred: ['text-generation'],
  },
  'audio-processing': {
    category: 'audio-processing',
    displayName: 'Audio processing',
    description: 'Turning speech into text the rest of the platform can use.',
    required: ['audio-input'],
    preferred: ['text-generation'],
  },
  'video-understanding': {
    category: 'video-understanding',
    displayName: 'Video understanding',
    description: 'Reading frames and sound from a video.',
    required: ['vision', 'audio-input'],
    preferred: ['text-generation'],
    structuralGap:
      'No connected adapter accepts video input. Video files can still be transcribed locally, but no model can be asked about a video yet.',
  },
  embeddings: {
    category: 'embeddings',
    displayName: 'Embeddings',
    description: 'Vector representations for search and grouping.',
    required: ['embeddings'],
    preferred: [],
    structuralGap:
      'The provider gateway has no embeddings adapter yet, so no connected provider can produce a vector.',
  },
};

export function requirementFor(category: TaskCategory): TaskRequirement {
  return TASK_REQUIREMENTS[category];
}

/** The requirement list, in a stable order for the UI. */
export const TASK_REQUIREMENT_LIST: readonly TaskRequirement[] = Object.values(TASK_REQUIREMENTS);
