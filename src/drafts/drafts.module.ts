import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';
import { SheetsService } from '../sheets/sheets.service';
import { Draft } from '../entities/draft.entity';
import { Job } from '../entities/job.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Draft, Job])],
  controllers: [DraftsController],
  providers: [DraftsService, SheetsService],
})
export class DraftsModule {}
