import { Injectable, type LoggerService } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  boundPlaceholders,
  isNonProductionStart,
  placeholdersAccepted,
} from './bound-placeholders';
import { FailClosedPlaceholder, PermissiveInterim, placeholderMarkOf } from './placeholder-markers';

const READER = Symbol('READER');
const OTHER = Symbol('OTHER');
const INTERIM = Symbol('INTERIM');

@FailClosedPlaceholder('sellers.allowedProductTypesOf')
@Injectable()
class UnavailableReader {
  read(): 'error' {
    return 'error';
  }
}

@PermissiveInterim('sellers.sellingEligibility')
class AllEligibleInterim {}

class RealReader {}

function recordingLogger() {
  const lines: { level: string; message: string }[] = [];
  const logger: LoggerService = {
    log: (message: string) => void lines.push({ level: 'log', message }),
    warn: (message: string) => void lines.push({ level: 'warn', message }),
    error: (message: string) => void lines.push({ level: 'error', message }),
  };
  return { lines, logger };
}

async function containerWith(
  providers: Parameters<typeof Test.createTestingModule>[0]['providers'],
) {
  const moduleRef = await Test.createTestingModule({ providers }).compile();
  return moduleRef.get(ModulesContainer);
}

const UNSET = { nodeEnv: 'development' as const, nodeEnvExplicit: false };
const EXPLICIT_TEST = { nodeEnv: 'test' as const, nodeEnvExplicit: true };
const EXPLICIT_DEVELOPMENT = { nodeEnv: 'development' as const, nodeEnvExplicit: true };
const EXPLICIT_PRODUCTION = { nodeEnv: 'production' as const, nodeEnvExplicit: true };

describe('ADR-0031 decision 4: the bound placeholder set', () => {
  it('marks a class once, with its kind and port', () => {
    expect(placeholderMarkOf(UnavailableReader)).toEqual({
      kind: 'fail-closed-placeholder',
      port: 'sellers.allowedProductTypesOf',
    });
    expect(placeholderMarkOf(AllEligibleInterim)).toEqual({
      kind: 'permissive-interim',
      port: 'sellers.sellingEligibility',
    });
    expect(placeholderMarkOf(RealReader)).toBeUndefined();
  });

  it('refuses a second mark and a port that is not "<module>.<method>"', () => {
    expect(() => FailClosedPlaceholder('x.y')(UnavailableReader)).toThrow(/two placeholder marks/);
    expect(() => FailClosedPlaceholder('allowedProductTypesOf')).toThrow(/<module>.<method>/);
    expect(() => PermissiveInterim('')).toThrow(/<module>.<method>/);
  });

  it('derives the set from the composition root, however the class is bound', async () => {
    const container = await containerWith([
      { provide: READER, useClass: UnavailableReader },
      { provide: OTHER, useFactory: () => new UnavailableReader() },
      { provide: INTERIM, useValue: new AllEligibleInterim() },
      RealReader,
    ]);

    expect(boundPlaceholders(container)).toEqual([
      {
        kind: 'fail-closed-placeholder',
        port: 'sellers.allowedProductTypesOf',
        className: 'UnavailableReader',
      },
      {
        kind: 'permissive-interim',
        port: 'sellers.sellingEligibility',
        className: 'AllEligibleInterim',
      },
    ]);
  });

  it('finds nothing in a graph with real bindings only', async () => {
    const container = await containerWith([{ provide: READER, useClass: RealReader }]);
    expect(boundPlaceholders(container)).toEqual([]);
  });

  it('counts a start as non-production only with NODE_ENV explicitly development or test', () => {
    expect(isNonProductionStart(EXPLICIT_TEST)).toBe(true);
    expect(isNonProductionStart(EXPLICIT_DEVELOPMENT)).toBe(true);
    expect(isNonProductionStart(UNSET)).toBe(false);
    expect(isNonProductionStart(EXPLICIT_PRODUCTION)).toBe(false);
  });

  it('refuses a start with NODE_ENV unset and one placeholder bound, and logs the set', async () => {
    const container = await containerWith([{ provide: READER, useClass: UnavailableReader }]);
    const { lines, logger } = recordingLogger();

    expect(placeholdersAccepted(container, UNSET, logger)).toBe(false);
    expect(lines).toEqual([
      {
        level: 'error',
        message: expect.stringContaining(
          'sellers.allowedProductTypesOf (fail-closed-placeholder: UnavailableReader)',
        ) as string,
      },
    ]);
  });

  it('refuses a production start with one permissive interim bound', async () => {
    const container = await containerWith([{ provide: INTERIM, useClass: AllEligibleInterim }]);
    expect(placeholdersAccepted(container, EXPLICIT_PRODUCTION, recordingLogger().logger)).toBe(
      false,
    );
  });

  it('lets an explicit development or test start go on with a warning', async () => {
    const container = await containerWith([{ provide: READER, useClass: UnavailableReader }]);
    for (const environment of [EXPLICIT_TEST, EXPLICIT_DEVELOPMENT]) {
      const { lines, logger } = recordingLogger();
      expect(placeholdersAccepted(container, environment, logger)).toBe(true);
      expect(lines.map((l) => l.level)).toEqual(['warn']);
    }
  });

  it('lets any start go on when nothing is bound, and says so', async () => {
    const container = await containerWith([RealReader]);
    const { lines, logger } = recordingLogger();
    expect(placeholdersAccepted(container, UNSET, logger)).toBe(true);
    expect(lines).toEqual([
      { level: 'log', message: expect.stringContaining('No placeholder') as string },
    ]);
  });
});
