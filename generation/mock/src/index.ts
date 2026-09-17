/**
 * @veltravia/generation-mock - offline, deterministic App Generation mocks.
 *
 * 1. `DeterministicPlanner`: a keyword-based planner that turns a natural
 *    language idea into a specification + generation plan using the
 *    built-in deterministic templates. It proves the COMPLETE architecture
 *    (spec -> plan -> approval -> project -> files -> sandbox -> result)
 *    with zero network, zero model calls, zero credentials.
 *
 * 2. `ScriptedRepairSource`: deterministic repair proposals for tests and
 *    the development API.
 *
 * DEVELOPMENT-ONLY: production never depends on this package. A real
 * planner routes through the provider-neutral AI Core with strict
 * structured-output validation; the engine re-validates either way.
 */

import type {
  AppSpecification,
  AppType,
  GenerationPlan,
  GenerationPlanner,
  PlannedFile,
  RepairContext,
  RepairProposal,
  RepairSource,
} from '@veltravia/generation-core';
import { createDefaultTemplateRegistry, selectTemplate } from '@veltravia/generation-core';

// ---------------------------------------------------------------------------
// Deterministic planner
// ---------------------------------------------------------------------------

export interface DeterministicPlannerOptions {
  /** Injectable clock - deterministic in tests, real time in production. */
  readonly now?: () => Date;
}

function nowIso(options?: DeterministicPlannerOptions): string {
  return (options?.now ?? (() => new Date()))().toISOString();
}

const NAME_FILLER = new Set([
  'build',
  'create',
  'make',
  'me',
  'a',
  'an',
  'the',
  'i',
  'want',
  'need',
  'please',
  'app',
  'application',
  'with',
  'for',
]);

function deriveName(idea: string): string {
  // Deterministic: the first few meaningful words become the app name.
  const cleaned = idea.replace(/[^A-Za-z0-9 ]+/g, ' ').trim();
  const words = cleaned
    .split(/\s+/)
    .filter((word) => !NAME_FILLER.has(word.toLowerCase()))
    .slice(0, 4);
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return name.length > 0 ? name.slice(0, 120) : 'Generated App';
}

function deriveAppType(idea: string): AppType {
  const text = idea.toLowerCase();
  const fullstack = /full[- ]?stack|frontend and backend|both a|api and (a )?(web|ui|front)/;
  const backend = /\bapi\b|backend|rest|graphql|server(?!-side ui)/;
  if (fullstack.test(text)) return 'fullstack';
  if (backend.test(text)) return 'backend-api';
  return 'web';
}

function deriveFeatures(idea: string): string[] {
  // Deterministic keyword sweep; bounded to at most 10 features.
  const candidates = [
    'accounts',
    'projects',
    'tasks',
    'dashboard',
    'search',
    'notifications',
    'reporting',
    'profile',
    'settings',
    'authentication',
  ];
  const text = idea.toLowerCase();
  return candidates.filter((candidate) => text.includes(candidate)).slice(0, 10);
}

function deriveScreens(idea: string): { name: string; description?: string }[] {
  const text = idea.toLowerCase();
  const screens: { name: string; description?: string }[] = [];
  if (text.includes('dashboard'))
    screens.push({ name: 'Dashboard', description: 'An overview of everything at a glance.' });
  if (text.includes('account') || text.includes('auth'))
    screens.push({ name: 'Account', description: 'Sign-in and profile management.' });
  if (text.includes('project'))
    screens.push({ name: 'Projects', description: 'Browse and manage projects.' });
  if (text.includes('task') || text.includes('todo'))
    screens.push({ name: 'Tasks', description: 'The working list of tasks.' });
  if (text.includes('setting'))
    screens.push({ name: 'Settings', description: 'Application preferences.' });
  if (screens.length === 0) screens.push({ name: 'Home', description: 'The landing screen.' });
  return screens.slice(0, 10);
}

function deriveEntities(
  idea: string,
): { name: string; fields: { name: string; type: string }[] }[] {
  const text = idea.toLowerCase();
  const entities: { name: string; fields: { name: string; type: string }[] }[] = [];
  if (text.includes('account') || text.includes('user')) {
    entities.push({
      name: 'Account',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'fullName', type: 'string' },
      ],
    });
  }
  if (text.includes('project')) {
    entities.push({
      name: 'Project',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'ownerId', type: 'string' },
      ],
    });
  }
  if (text.includes('task') || text.includes('todo')) {
    entities.push({
      name: 'Task',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'projectId', type: 'string' },
        { name: 'done', type: 'boolean' },
      ],
    });
  }
  return entities.slice(0, 10);
}

/**
 * A deterministic planner: the same idea ALWAYS produces the same spec and
 * plan. It never invents capabilities - the engine re-validates everything.
 */
export class DeterministicPlanner implements GenerationPlanner {
  constructor(private readonly options: DeterministicPlannerOptions = {}) {}

  async plan(idea: string): Promise<{ spec: AppSpecification; plan: GenerationPlan }> {
    const appType = deriveAppType(idea);
    const spec: AppSpecification = {
      name: deriveName(idea),
      description: idea.slice(0, 400),
      appType,
      targetPlatform:
        appType === 'web' ? 'web' : appType === 'backend-api' ? 'server' : 'web+server',
      features: deriveFeatures(idea),
      screens: deriveScreens(idea),
      entities: deriveEntities(idea),
      integrations: [],
      constraints: [],
      version: '0.1.0',
      generatedAt: nowIso(this.options),
    };
    const registry = createDefaultTemplateRegistry();
    const templates = registry.list();
    const template = selectTemplate(spec, templates);
    const files: PlannedFile[] = [...template.generateFiles(spec)];
    const plan: GenerationPlan = {
      version: '1.0.0',
      project: {
        name: spec.name,
        description: spec.description,
        projectType: appType,
      },
      templateId: template.id,
      filesToCreate: files,
      filesToModify: [],
      dependencies: template.requiredDependencies.map((name) => ({
        name,
        versionRange: '*',
        reason: `required by the ${template.name} template`,
        source: 'npm' as const,
      })),
      commands: template.testCommands.map((command) => ({
        command: command.command,
        arguments: [...command.arguments],
        purpose: command.purpose,
        phase: 'test' as const,
      })),
      risk: {
        destructiveActions: [],
        confirmationRequiringTools: ['sandbox.execute'],
        externalIntegrations: [...spec.integrations],
      },
    };
    return { spec, plan };
  }
}

export function createDeterministicPlanner(
  options: DeterministicPlannerOptions = {},
): DeterministicPlanner {
  return new DeterministicPlanner(options);
}

// ---------------------------------------------------------------------------
// Scripted repair source
// ---------------------------------------------------------------------------

export interface ScriptedRepairSourceOptions {
  /**
   * Proposals returned in order. An exhausted script proposes nothing -
   * a deterministic decline, never an invented fix.
   */
  readonly proposals: readonly RepairProposal[];
}

export class ScriptedRepairSource implements RepairSource {
  private index = 0;
  private readonly proposals: readonly RepairProposal[];

  constructor(options: ScriptedRepairSourceOptions) {
    this.proposals = [...options.proposals];
  }

  async proposeFixes(_context: RepairContext): Promise<RepairProposal> {
    void _context;
    if (this.index >= this.proposals.length) {
      return { description: 'no further repair proposals available', filesToWrite: [] };
    }
    const proposal = this.proposals[this.index] as RepairProposal;
    this.index += 1;
    return proposal;
  }
}

export function createScriptedRepairSource(
  proposals: readonly RepairProposal[],
): ScriptedRepairSource {
  return new ScriptedRepairSource({ proposals });
}

/**
 * A declining repair source: always proposes nothing. Used to prove the
 * engine fails HONESTLY when no repair is possible - never loops, never
 * claims success.
 */
export class DecliningRepairSource implements RepairSource {
  async proposeFixes(_context: RepairContext): Promise<RepairProposal> {
    void _context;
    return { description: 'declining repair source has no proposals', filesToWrite: [] };
  }
}

export function createDecliningRepairSource(): DecliningRepairSource {
  return new DecliningRepairSource();
}
