import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Headers,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import { LiveDraftService } from './live-draft.service';
import { IsString } from 'class-validator';

class InitializeLiveDraftDto {
  @IsString()
  leagueId: string;
}

@Controller('live-draft')
export class LiveDraftController {
  private readonly logger = new Logger(LiveDraftController.name);

  constructor(
    private readonly liveDraftService: LiveDraftService,
    private readonly config: ConfigService,
  ) {}

  private checkSecret(headerValue: string | undefined) {
    const secret = this.config.get<string>('LIVE_DRAFT_SECRET');
    if (!secret) {
      this.logger.warn('LIVE_DRAFT_SECRET not set — live draft endpoints are unprotected');
      return;
    }
    if (headerValue !== secret) {
      throw new UnauthorizedException('Invalid X-Live-Draft-Secret');
    }
  }

  /**
   * POST /live-draft/initialize
   * Cancels any active drafts for both users, provisions new sheets,
   * and sets jobs to RUNNING/draft_live so the frontend shows the live panel.
   *
   * Protected by X-Live-Draft-Secret header.
   */
  @Public()
  @Post('initialize')
  async initialize(
    @Body() dto: InitializeLiveDraftDto,
    @Headers('x-live-draft-secret') secret: string | undefined,
  ) {
    this.checkSecret(secret);
    return this.liveDraftService.initialize(dto.leagueId);
  }

  /**
   * GET /live-draft/snippet?leagueId=...
   * Returns a ready-to-paste JavaScript snippet pre-filled with BACKEND_URL,
   * PICK_SECRET, and the requested leagueId.
   *
   * Protected by X-Live-Draft-Secret header.
   */
  @Public()
  @Get('snippet')
  getSnippet(
    @Query('leagueId') leagueId: string,
    @Headers('x-live-draft-secret') secret: string | undefined,
  ) {
    this.checkSecret(secret);
    const snippet = this.liveDraftService.getSnippet(leagueId || '');
    return { snippet };
  }
}
