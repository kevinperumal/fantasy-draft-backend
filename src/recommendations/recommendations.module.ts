import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SheetsModule } from '../sheets/sheets.module';
import { Draft } from '../entities/draft.entity';
import { PickRecord } from '../entities/pick.entity';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';

@Module({
  imports: [SheetsModule, TypeOrmModule.forFeature([Draft, PickRecord])],
  controllers: [RecommendationsController],
  providers: [RecommendationsService],
})
export class RecommendationsModule {}
