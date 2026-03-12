import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
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
  constructor(
    private readonly draftsService: DraftsService,
    private readonly http: HttpService,
  ) {}

  // --- Draft lifecycle endpoints ---

  @Post('drafts')
  createDraft(
    @Req() req: any,
    @Body() body: { leagueId: string; sport?: string },
  ) {
    return this.draftsService.createDraft(req.user.sub, body.leagueId, body.sport);
  }

  @Get('drafts/active')
  getActiveDraft(@Req() req: any) {
    return this.draftsService.getActiveDraft(req.user.sub);
  }

  @Post('drafts/:id/cancel')
  async cancelDraft(@Req() req: any, @Param('id') id: string) {
    await this.draftsService.cancelDraft(req.user.sub, id);
    return { ok: true };
  }

  // --- Legacy pick reporting (called by injected script — no auth cookie) ---

  @Public()
  @Post('picks')
  async handlePick(@Body() body: PickDto) {
    await this.draftsService.processPick(body);
    return { ok: true };
  }

  // --- Legacy direct worker trigger (kept for now, removed in Phase 4) ---

  @Post('monitor')
  async startMonitor(@Body() body: { leagueId: string; sport?: string }) {
    const { leagueId, sport = 'baseball' } = body;
    if (!leagueId) return { error: 'leagueId is required' };
    const workerBase = process.env.WORKER_URL || 'http://localhost:4000';
    await this.http.post(`${workerBase}/run`, { leagueId, sport }).toPromise();
    return { status: 'started', leagueId, sport };
  }
}
