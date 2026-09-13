/**
 * @veltravia/types - core domain types shared across all Veltravia AI services.
 *
 * Keep this package dependency-free. Anything imported by both `apps/web` and
 * `apps/api` belongs here.
 */

export const VELTRAVIA_NAME = 'Veltravia AI' as const;
export const VELTRAVIA_VERSION = '0.1.0' as const;

/** Known Veltravia AI services. */
export type ServiceName = 'web' | 'api';

/** Runtime environments. */
export type Environment = 'development' | 'test' | 'production';

/** Contract for service health-check endpoints. */
export interface HealthCheckResponse {
  status: 'ok' | 'error';
  service: string;
  version: string;
  timestamp: string;
}

/** Lifecycle stages planned for the platform (foundation only for now). */
export type PlatformStage = 'foundation' | 'core-ai' | 'connectors' | 'self-development';
