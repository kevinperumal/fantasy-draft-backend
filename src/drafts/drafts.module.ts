import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SheetsModule } from '../sheets/sheets.module';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';
import { Draft } from '../entities/draft.entity';
import { Job } from '../entities/job.entity';
import { PickRecord } from '../entities/pick.entity';

@Module({
  imports: [SheetsModule, TypeOrmModule.forFeature([Draft, Job, PickRecord])],
  controllers: [DraftsController],
  providers: [DraftsService],
})
export class DraftsModule {}
