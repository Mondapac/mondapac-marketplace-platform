import { ApiProperty } from '@nestjs/swagger';
import type { ListPaging } from '../domain/definitions';
import { LIST_PAGING_VALUES, SETTING_DEFINITIONS } from '../domain/definitions';
import type { SettingView } from '../application/use-cases/view-market-settings.use-case';

export class SettingBody {
  @ApiProperty({ enum: SETTING_DEFINITIONS.map((definition) => definition.code) }) code!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ description: '0 while the default is in force.' }) version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
}

export class SettingsListBody {
  @ApiProperty({ type: [SettingBody] }) settings!: SettingBody[];
}

export class ChangeSettingRequest {
  @ApiProperty() code!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ description: 'The version the admin saw; a stale edit is refused (409).' })
  expectedVersion!: number;
}

export class ListPagingBody {
  @ApiProperty({ enum: [...LIST_PAGING_VALUES] }) listPaging!: string;
}

export const settingBody = (view: SettingView): SettingBody => ({
  code: view.code,
  value: view.value,
  version: view.version,
  updatedAt: view.updatedAt === null ? null : view.updatedAt.toString(),
});

export const settingsListBody = (views: readonly SettingView[]): SettingsListBody => ({
  settings: views.map(settingBody),
});

export const listPagingBody = (value: ListPaging): ListPagingBody => ({ listPaging: value });
