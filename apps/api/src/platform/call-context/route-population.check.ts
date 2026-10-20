import { Injectable, RequestMethod } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { isMarketContextExempt } from '../market-context/market-context.guard';
import {
  READS_SESSION,
  ROUTE_POPULATION,
  routePopulationOf,
  STOREFRONT_ORIGIN,
  STOREFRONT_ORIGIN_ROUTES,
} from './route-population.decorator';

/** Request methods that change nothing (RFC 9110 9.2.1); `ALL` and every other one are unsafe. */
const SAFE_REQUEST_METHODS: ReadonlySet<RequestMethod> = new Set([
  RequestMethod.GET,
  RequestMethod.HEAD,
  RequestMethod.OPTIONS,
]);

/** The start-up failure of {@link RoutePopulationCheck}. */
export class RoutePopulationError extends Error {
  constructor(problems: readonly string[]) {
    super(`Route populations are not configured correctly:\n- ${problems.join('\n- ')}`);
    this.name = 'RoutePopulationError';
  }
}

type ControllerClass = abstract new (...args: never[]) => unknown;

/** A route path without leading, trailing or repeated slashes; `null` for a list of paths. */
function pathOf(metadata: unknown): string | null {
  if (Array.isArray(metadata)) {
    return metadata.length === 1 ? pathOf(metadata[0]) : null;
  }
  return typeof metadata === 'string' ? metadata.split('/').filter(Boolean).join('/') : '';
}

/**
 * `METHOD path` of a handler, as {@link STOREFRONT_ORIGIN_ROUTES} spells it, or `null` when the
 * controller or the handler declares several paths (Hassan, PR #443 finding 2: a path list
 * would carry the exception to its other paths).
 */
function routeKeyOf(controller: object, handler: object): string | null {
  const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
  const parts = [
    pathOf(Reflect.getMetadata(PATH_METADATA, controller)),
    pathOf(Reflect.getMetadata(PATH_METADATA, handler)),
  ];
  if (parts.includes(null)) return null;
  const path = parts.filter(Boolean).join('/');
  return `${method === undefined ? '?' : RequestMethod[method]} ${path}`;
}

/**
 * Every problem with the route populations of the given controllers (identity design 6.4; Ali's
 * ruling and Hassan's review of 2026-10-08), in a stable order. Empty when all hold:
 * - a market-scoped controller carries `@RoutePopulation` on its class;
 * - no method carries `@RoutePopulation` (class only, so no route uses another allow-list);
 * - `@ReadsSession` is used only on a controller with a `@RoutePopulation`;
 * - a market-exempt controller has no route with an unsafe method (the actor guard returns
 *   before the origin check for such a controller);
 * - `@AcceptsStorefrontOrigin` sits only on a method of a `seller` controller, on a route of
 *   `STOREFRONT_ORIGIN_ROUTES`, and never on a route that reads a session.
 */
export function routePopulationProblems(controllers: readonly ControllerClass[]): string[] {
  const scanner = new MetadataScanner();
  const problems: string[] = [];
  for (const controller of controllers) {
    const name = controller.name;
    const prototype = controller.prototype as Record<string, unknown>;
    const methods = scanner
      .getAllMethodNames(prototype)
      .map((key) => ({ key, handler: prototype[key] }))
      .filter(
        (method): method is { key: string; handler: object } =>
          typeof method.handler === 'function',
      );
    const population = routePopulationOf(controller);
    const exempt = isMarketContextExempt(controller);

    for (const { key, handler } of methods) {
      if (Reflect.getOwnMetadata(ROUTE_POPULATION, handler) !== undefined) {
        problems.push(`${name}.${key} carries @RoutePopulation; it belongs on the class only`);
      }
    }
    if (Reflect.getMetadata(STOREFRONT_ORIGIN, controller) !== undefined) {
      problems.push(`${name} carries @AcceptsStorefrontOrigin; it belongs on a listed route only`);
    }
    for (const { key, handler } of methods) {
      if (Reflect.getOwnMetadata(STOREFRONT_ORIGIN, handler) === undefined) continue;
      const route = routeKeyOf(controller, handler);
      if (route === null) {
        problems.push(`${name}.${key} carries @AcceptsStorefrontOrigin on a list of paths`);
      } else if (population !== 'seller' || !STOREFRONT_ORIGIN_ROUTES.has(route)) {
        problems.push(
          `${name}.${key} carries @AcceptsStorefrontOrigin on ${route}, which is not a listed seller route`,
        );
      }
      if (
        Reflect.getMetadata(READS_SESSION, controller) === true ||
        Reflect.getOwnMetadata(READS_SESSION, handler) === true
      ) {
        problems.push(`${name}.${key} carries @AcceptsStorefrontOrigin and reads a session`);
      }
    }
    const readsSession =
      Reflect.getMetadata(READS_SESSION, controller) === true ||
      methods.some(({ handler }) => Reflect.getOwnMetadata(READS_SESSION, handler) === true);
    if (readsSession && population === undefined) {
      problems.push(`${name} uses @ReadsSession without a @RoutePopulation on the class`);
    } else if (!exempt && population === undefined) {
      problems.push(`${name} is market-scoped and has no @RoutePopulation on the class`);
    }
    if (exempt) {
      for (const { key, handler } of methods) {
        if (!Reflect.hasMetadata(PATH_METADATA, handler)) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined || !SAFE_REQUEST_METHODS.has(method)) {
          problems.push(
            `${name}.${key} has an unsafe method on a market-exempt controller (no origin check)`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Refuses to start the application when a controller breaks a route-population rule
 * ({@link routePopulationProblems}). The controllers are found at run time through Nest's
 * `DiscoveryService`, never from a hand-kept list (Hassan), so a new controller is checked
 * the moment it is registered.
 */
@Injectable()
export class RoutePopulationCheck implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    const controllers = new Set<ControllerClass>();
    for (const wrapper of this.discovery.getControllers()) {
      if (typeof wrapper.metatype === 'function') {
        controllers.add(wrapper.metatype as ControllerClass);
      }
    }
    const problems = routePopulationProblems([...controllers]);
    if (problems.length > 0) throw new RoutePopulationError(problems);
  }
}
