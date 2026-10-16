import type { LoggerService } from '@nestjs/common';
import type { ModulesContainer } from '@nestjs/core';
import type { AppConfig } from '../config/app-config';
import { type PlaceholderMark, placeholderMarkOf } from './placeholder-markers';

/** One marked binding found in the composition root. */
export interface BoundPlaceholder extends PlaceholderMark {
  /** The bound class's name, for the log line. */
  readonly className: string;
}

/**
 * ADR-0031 decision 4: the bound set is derived from the composition root at start-up, never
 * hand-maintained. Every provider of every module is read: its class (`useClass` and class
 * providers) and the constructor of its instance (`useValue`, `useFactory`), so a marked class
 * counts however it was bound. Sorted by port, one entry per class.
 */
export function boundPlaceholders(container: ModulesContainer): readonly BoundPlaceholder[] {
  const found = new Map<string, BoundPlaceholder>();
  for (const module of container.values()) {
    for (const wrapper of module.providers.values()) {
      const candidates: unknown[] = [wrapper.metatype];
      const instance: unknown = wrapper.instance;
      if (typeof instance === 'object' && instance !== null) candidates.push(instance.constructor);
      for (const candidate of candidates) {
        const mark = placeholderMarkOf(candidate);
        if (mark === undefined) continue;
        const className = (candidate as { name: string }).name;
        found.set(`${mark.port}|${className}`, { ...mark, className });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.port === b.port ? a.className.localeCompare(b.className) : a.port.localeCompare(b.port),
  );
}

/**
 * ADR-0031 decision 4: a start is non-production only when `NODE_ENV` was set explicitly to
 * `development` or `test`. Unset counts as production, with no override (the same predicate as
 * the stack-secret stand-ins).
 */
export function isNonProductionStart(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): boolean {
  const { nodeEnv, nodeEnvExplicit } = environment;
  return nodeEnvExplicit === true && (nodeEnv === 'development' || nodeEnv === 'test');
}

/**
 * The start-up self-check of ADR-0031 decision 4, run by the api and the worker before they
 * serve or schedule: the bound set is always logged, and a non-empty set refuses a production
 * start. Answers whether the process may go on.
 */
export function placeholdersAccepted(
  container: ModulesContainer,
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
  logger: LoggerService,
): boolean {
  const bound = boundPlaceholders(container);
  if (bound.length === 0) {
    logger.log('No placeholder binding is bound (ADR-0031)', 'PlaceholderCheck');
    return true;
  }
  const list = bound.map((b) => `${b.port} (${b.kind}: ${b.className})`).join(', ');
  if (isNonProductionStart(environment)) {
    logger.warn(
      `Placeholder bindings are bound; this build cannot serve a sale (ADR-0031): ${list}`,
      'PlaceholderCheck',
    );
    return true;
  }
  logger.error(
    `A production start was refused because placeholder bindings are bound (ADR-0031 decision 4): ${list}`,
    'PlaceholderCheck',
  );
  return false;
}
