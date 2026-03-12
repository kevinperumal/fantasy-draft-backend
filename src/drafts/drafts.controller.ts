import { Controller, Post, Body } from '@nestjs/common';
import { DraftsService } from './drafts.service';
import { HttpService } from '@nestjs/axios';
import { Public } from '../auth/public.decorator';

export class PickDto {
  sessionId?: string;
  player: string;
  team: string;
  position: string;
}

@Controller()
export class DraftsController {
  constructor(private readonly draftsService: DraftsService, private readonly http: HttpService) {}
  //
  @Post('monitor')
  async startMonitor(@Body() body: { leagueId: string; sport?: string }) {
    const { leagueId, sport = 'baseball' } = body;
    if (!leagueId) {
      return { error: 'leagueId is required' };
    }

    // Worker URL – inside Docker this will be http://worker:4000
    const workerBase = process.env.WORKER_URL || 'http://localhost:4000';

    // fire-and-forget HTTP call to the worker
    await this.http
      .post(`${workerBase}/run`, { leagueId, sport })
      .toPromise();

    return { status: 'started', leagueId, sport };
  }

  // Called by the injected script inside the Puppeteer browser — no auth cookie available
  @Public()
  @Post('picks')
  async handlePick(@Body() body: PickDto) {
    await this.draftsService.processPick(body);
    return { ok: true };
  }
}
