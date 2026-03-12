import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DraftsModule } from './drafts/drafts.module';
import { AppController } from './app.controller';
import { WorkerController } from './worker.controller';
import { User } from './entities/user.entity';
import { Draft } from './entities/draft.entity';
import { Job } from './entities/job.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: [User, Draft, Job],
        // In production set synchronize: false and use migrations
        synchronize: config.get<string>('NODE_ENV') !== 'production',
        ssl: config.get<string>('DATABASE_SSL') !== 'false'
          ? { rejectUnauthorized: false }
          : false,
      }),
    }),
    DraftsModule,
  ],
  controllers: [AppController, WorkerController],
})
export class AppModule {}
