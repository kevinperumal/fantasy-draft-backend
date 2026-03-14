import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DraftsModule } from './drafts/drafts.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
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
        synchronize: config.get<string>('DB_SYNCHRONIZE') === 'true',
        ssl:
          config.get<string>('DATABASE_SSL') !== 'false'
            ? { rejectUnauthorized: false }
            : false,
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    AuthModule,
    DraftsModule,
  ],
  controllers: [AppController],
  providers: [
    // Apply JwtAuthGuard to every route; use @Public() to opt out
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Apply rate limiting globally
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
