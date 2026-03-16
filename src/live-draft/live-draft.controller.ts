import { Controller, Post, Get, Body, Query } from '@nestjs/common';
import { LiveDraftService } from './live-draft.service';
import { IsString } from 'class-validator';

class InitializeLiveDraftDto {
  @IsString()
  leagueId: string;
}

@Controller('live-draft')
export class LiveDraftController {
  constructor(private readonly liveDraftService: LiveDraftService) {}

  /**
   * POST /live-draft/initialize
   * Cancels any active drafts for both users, provisions new sheets,
   * and sets jobs to RUNNING/draft_live so the frontend shows the live panel.
   * JWT-protected (global JwtAuthGuard).
   */
  @Post('initialize')
  initialize(@Body() dto: InitializeLiveDraftDto) {
    return this.liveDraftService.initialize(dto.leagueId);
  }

  /**
   * GET /live-draft/snippet?leagueId=...
   * Returns a ready-to-paste JS snippet pre-filled with BACKEND_URL,
   * PICK_SECRET, and the requested leagueId.
   * JWT-protected (global JwtAuthGuard).
   */
  @Get('snippet')
  getSnippet(@Query('leagueId') leagueId: string) {
    return { snippet: this.liveDraftService.getSnippet(leagueId || '') };
  }
}
