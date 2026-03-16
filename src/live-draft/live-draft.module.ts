import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LiveDraftController } from './live-draft.controller';
import { LiveDraftService } from './live-draft.service';
import { SheetsModule } from '../sheets/sheets.module';
import { Draft } from '../entities/draft.entity';
import { Job } from '../entities/job.entity';
import { User } from '../entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Draft, Job, User]),
    SheetsModule,
  ],
  controllers: [LiveDraftController],
  providers: [LiveDraftService],
})
export class LiveDraftModule {}
