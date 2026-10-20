import { createHmac } from 'node:crypto';
import { All, Controller, Post, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { RoutePopulationError } from '../src/platform/call-context/route-population.check';
import {
  AcceptsStorefrontOrigin,
  ReadsSession,
  RoutePopulation,
  routePopulationOf,
  STOREFRONT_ORIGIN_ROUTES,
} from '../src/platform/call-context/route-population.decorator';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders } from './support/test-config';

// The storefront's seller sign-up (john's decision of 2026-10-20 on PR #442, Hassan's
// conditions): `POST identity/seller/sign-up` and `verification-email` also accept the
// Market's storefront (customer) origin, same-origin and with a client address proved under a
// storefront key (ADR-0037). The seller list never holds the storefront, every other admin and
// seller route still refuses it, and the seller panel's own requests are unchanged. The test
// client connects from 127.0.0.1, configured as the one BFF network, so a request with a proof
// plays a BFF.

const KEY = Buffer.alloc(32, 0x3c).toString('base64');
const NEXT_KEY = Buffer.alloc(32, 0x3d).toString('base64');
const PANEL_KEY = Buffer.alloc(32, 0x3e).toString('base64');
const KEYS: Record<string, string> = {
  storefront: KEY,
  'storefront-2': NEXT_KEY,
  panel: PANEL_KEY,
};
const BFF_ENV = {
  TRUSTED_BFF_CIDRS: '127.0.0.1/32,::1/128',
  CLIENT_ADDRESS_KEYS: Object.entries(KEYS)
    .map(([keyId, secret]) => `${keyId}:127.0.0.1/32,::1/128:${secret}`)
    .join(';'),
};
/** test/fixtures/markets/ZZ.json: `allowedOrigins.customer`. */
const STOREFRONT = 'https://storefront.zz.test';
/** A new client address per request, so the per-origin limits never meet a test's refusals. */
let clients = 0;
const nextClient = (): string => {
  clients += 1;
  return `198.18.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
};
const SIGN_UP = {
  displayName: 'Amina Rahman',
  email: 'Owner@Example.com',
  password: 'x'.repeat(20),
};
const CSRF = { statusCode: 403, code: 'request.csrf' };
const fakes = new IdentityFakes();

function proof(market: string, keyId = 'storefront'): string {
  const client = nextClient();
  const t = String(Math.floor(Date.now() / 1000));
  const s = createHmac('sha256', Buffer.from(KEYS[keyId]!, 'base64'))
    .update(`v1\n${keyId}\n${t}\n${client}\n${market}`, 'utf8')
    .digest('base64url');
  return `v1;k=${keyId};t=${t};a=${client};s=${s}`;
}

/** As the storefront's BFF relays the sign-up page: same-origin, its origin, the proof. */
const fromStorefront = (market: string, keyId = 'storefront') => ({
  'x-market-id': market,
  'x-client-address': proof(market, keyId),
  origin: STOREFRONT,
  'sec-fetch-site': 'same-origin',
});

@RoutePopulation('seller')
@Controller('test/storefront-origin/unlisted')
class UnlistedRouteController {
  @Post('sign-in')
  @AcceptsStorefrontOrigin()
  write(): void {}
}

@RoutePopulation('customer')
@Controller('identity/seller')
class CustomerPopulationController {
  @Post('sign-up')
  @AcceptsStorefrontOrigin()
  write(): void {}
}

@RoutePopulation('seller')
@Controller('identity/seller')
class SessionReadingController {
  @Post('verification-email')
  @AcceptsStorefrontOrigin()
  @ReadsSession()
  write(): void {}
}

@RoutePopulation('seller')
@Controller('identity/seller')
class PathListController {
  @Post(['sign-up', 'sign-in'])
  @AcceptsStorefrontOrigin()
  write(): void {}
}

@RoutePopulation('seller')
@Controller('identity/seller')
class AllMethodsController {
  @All('sign-up')
  @AcceptsStorefrontOrigin()
  write(): void {}
}

@RoutePopulation('seller')
@(AcceptsStorefrontOrigin() as unknown as ClassDecorator)
@Controller('test/storefront-origin/class')
class ClassLevelController {}

describe('@AcceptsStorefrontOrigin at start-up', () => {
  it('lists exactly the two seller sign-up routes', () => {
    expect([...STOREFRONT_ORIGIN_ROUTES]).toEqual([
      'POST identity/seller/sign-up',
      'POST identity/seller/verification-email',
    ]);
  });

  it.each([
    [
      UnlistedRouteController,
      /UnlistedRouteController\.write carries @AcceptsStorefrontOrigin on POST test\/storefront-origin\/unlisted\/sign-in/,
    ],
    [
      CustomerPopulationController,
      /CustomerPopulationController\.write carries @AcceptsStorefrontOrigin on POST identity\/seller\/sign-up, which is not a listed seller route/,
    ],
    [
      SessionReadingController,
      /SessionReadingController\.write carries @AcceptsStorefrontOrigin and reads a session/,
    ],
    [
      PathListController,
      /PathListController\.write carries @AcceptsStorefrontOrigin on a list of paths/,
    ],
    [
      AllMethodsController,
      /AllMethodsController\.write carries @AcceptsStorefrontOrigin on ALL identity\/seller\/sign-up, which is not a listed seller route/,
    ],
    [
      ClassLevelController,
      /ClassLevelController carries @AcceptsStorefrontOrigin; it belongs on a listed route only/,
    ],
  ])('refuses to boot with %p', async (controller, message) => {
    const booting = createTestApp({ controllers: [controller] });

    await expect(booting).rejects.toThrow(RoutePopulationError);
    await expect(createTestApp({ controllers: [controller] })).rejects.toThrow(message);
  });
});

describe('seller sign-up from the storefront (HF14, ADR-0037)', () => {
  let app: NestExpressApplication;
  let unproven: NestExpressApplication;
  const post = (target: NestExpressApplication, path: string, headers: Record<string, string>) =>
    request(target.getHttpServer()).post(path).set(headers);
  const signUp = (headers: Record<string, string>, target = app) =>
    post(target, '/identity/seller/sign-up', headers).send(SIGN_UP);
  const resend = (headers: Record<string, string>, target = app) =>
    post(target, '/identity/seller/verification-email', headers).send({ email: SIGN_UP.email });

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: BFF_ENV,
      panelOrigins: true,
      override: (builder) => fakes.override(builder),
    }));
    // No BFF network configured: an address can only be the socket's, never proved.
    ({ app: unproven } = await createTestApp({
      panelOrigins: true,
      override: (builder) => fakes.override(builder),
    }));
  });
  afterAll(async () => {
    await app.close();
    await unproven.close();
  });
  beforeEach(async () => {
    fakes.reset();
    const system = testCallContext(
      testMarketContext('ZZ', PLATFORM_TENANT_ID),
      'system',
      'storefront-origin-0001',
    );
    await app.get(SeedRoles).execute(system, {});
  });

  it('accepts sign-up and "send it again" from the storefront through its BFF', async () => {
    await signUp(fromStorefront('ZZ')).expect(202);
    await resend(fromStorefront('ZZ')).expect(202);
  });

  it('accepts a later storefront key generation (ADR-0037 rotation)', async () => {
    await signUp(fromStorefront('ZZ', 'storefront-2')).expect(202);
  });

  it("refuses the storefront origin under another BFF's key (the panel's)", async () => {
    expect((await signUp(fromStorefront('ZZ', 'panel')).expect(403)).body).toEqual(CSRF);
    expect((await resend(fromStorefront('ZZ', 'panel')).expect(403)).body).toEqual(CSRF);
  });

  it('still accepts the seller panel, unchanged', async () => {
    const panel = {
      'x-market-id': 'ZZ',
      'x-client-address': proof('ZZ'),
      ...panelHeaders('ZZ', 'seller'),
    };

    await signUp(panel).expect(202);
    await resend(panel).expect(202);
  });

  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ["the admin panel's origin", { origin: panelHeaders('ZZ', 'admin').origin }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site fetch', { 'sec-fetch-site': 'same-site' }],
  ])('refuses the sign-up routes with %s', async (_case, change) => {
    const headers = { ...fromStorefront('ZZ'), ...change };

    expect((await signUp(headers).expect(403)).body).toEqual(CSRF);
    expect((await resend(headers).expect(403)).body).toEqual(CSRF);
  });

  it.each([['origin'], ['sec-fetch-site']])(
    'refuses the sign-up routes without %s',
    async (name) => {
      const headers: Record<string, string> = fromStorefront('ZZ');
      delete headers[name];

      expect((await signUp(headers).expect(403)).body).toEqual(CSRF);
      expect((await resend(headers).expect(403)).body).toEqual(CSRF);
    },
  );

  it('refuses the storefront origin without a client address proved by a BFF', async () => {
    const headers: Record<string, string> = fromStorefront('ZZ');
    delete headers['x-client-address'];

    expect((await signUp(headers, unproven).expect(403)).body).toEqual(CSRF);
    expect((await resend(headers, unproven).expect(403)).body).toEqual(CSRF);
  });

  it('refuses the storefront where the Market lists no storefront origin (AU, fail closed)', async () => {
    expect((await signUp(fromStorefront('AU')).expect(403)).body).toEqual(CSRF);
    expect((await resend(fromStorefront('AU')).expect(403)).body).toEqual(CSRF);
  });

  it('refuses the storefront origin on every other unsafe admin and seller route', async () => {
    const scanner = new MetadataScanner();
    const pathOf = (metadata: unknown): string => {
      const first: unknown = Array.isArray(metadata) ? metadata[0] : metadata;
      return typeof first === 'string' ? first.split('/').filter(Boolean).join('/') : '';
    };
    const routes: { method: RequestMethod; path: string }[] = [];
    for (const moduleRef of app.get(ModulesContainer).values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        const controller = wrapper.metatype as (new () => unknown) | null;
        if (controller === null) continue;
        const population = routePopulationOf(controller);
        if (population !== 'seller' && population !== 'admin') continue;
        const prototype = controller.prototype as Record<string, object>;
        for (const key of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[key]!;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (!Reflect.hasMetadata(PATH_METADATA, handler) || method === undefined) continue;
          if ([RequestMethod.GET, RequestMethod.HEAD, RequestMethod.OPTIONS].includes(method))
            continue;
          const path = [
            Reflect.getMetadata(PATH_METADATA, controller),
            Reflect.getMetadata(PATH_METADATA, handler),
          ]
            .map(pathOf)
            .filter(Boolean)
            .join('/');
          if (
            population === 'seller' &&
            STOREFRONT_ORIGIN_ROUTES.has(`${RequestMethod[method]} ${path}`)
          )
            continue;
          routes.push({ method, path });
        }
      }
    }
    // A sanity floor: the seller sign-in and confirm-email routes and many more are covered.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.map((route) => route.path)).toEqual(
      expect.arrayContaining(['identity/seller/sign-in', 'identity/seller/confirm-email']),
    );

    const server = request(app.getHttpServer());
    for (const { method, path } of routes) {
      const url = '/' + path.replace(/:[A-Za-z]+/g, '0199aaaa-0000-7000-8000-000000000001');
      const verb = RequestMethod[method].toLowerCase() as 'post' | 'put' | 'patch' | 'delete';
      const response = await server[verb](url).set(fromStorefront('ZZ')).send({});

      expect({
        route: `${RequestMethod[method]} ${path}`,
        status: response.status,
        body: response.body as unknown,
      }).toEqual({
        route: `${RequestMethod[method]} ${path}`,
        status: 403,
        body: CSRF,
      });
    }
  });
});
