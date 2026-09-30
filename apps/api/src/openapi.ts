import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/** Builds the OpenAPI document from the controllers' decorators. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('MondaPac Marketplace API')
    .setVersion('0.0.0')
    .build();
  return SwaggerModule.createDocument(app, config);
}
