import { Module } from '@nestjs/common';
import { DraftsModule } from './drafts/drafts.module';
import { AppController } from './app.controller';
import { WorkerController } from './worker.controller';

@Module({
  imports: [DraftsModule],
  controllers: [AppController, WorkerController]
})
export class AppModule {}
