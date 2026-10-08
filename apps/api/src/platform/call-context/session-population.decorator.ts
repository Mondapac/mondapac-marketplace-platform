import { Reflector } from '@nestjs/core';
import type { Population } from '@mondapac/shared-kernel';

/**
 * The population whose session a route reads (identity design 6.4): the actor guard reads only
 * the session cookie named for this population and the request's Market, and refuses a session
 * of another population. A route without it reads no session: its actor is the Market's
 * anonymous actor, whatever cookie the request carries (sign-in, sign-up and reset requests).
 */
export const SESSION_POPULATION = Reflector.createDecorator<Population>();

/** Puts a controller, or one of its routes, behind the session of one population. */
export function SessionPopulation(population: Population): ClassDecorator & MethodDecorator {
  return SESSION_POPULATION(population);
}
