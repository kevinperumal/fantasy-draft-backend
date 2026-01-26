import { Module } from '@nestjs/common';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';
import { SheetsService } from '../sheets/sheets.service';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [HttpModule],
  controllers: [DraftsController],
  providers: [DraftsService, SheetsService],
})
export class DraftsModule {}
