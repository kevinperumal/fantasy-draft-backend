import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { DraftsService } from './drafts.service';
import { Public } from '../auth/public.decorator';

export class PickDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  leagueId?: string;

  @IsString()
  @MaxLength(100)
  player: string;

  @IsString()
  @MaxLength(50)
  team: string;

  @IsString()
  @MaxLength(50)
  position: string;

  // ESPN fantasy team name that made this pick (best-effort from DOM)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pickerTeam?: string;
}

@Controller()
export class DraftsController {
  constructor(private readonly draftsService: DraftsService) {}

  // --- Draft lifecycle endpoints ---

  @Post('drafts')
  createDraft(
    @Req() req: any,
    @Body() body: { leagueId: string; sport?: string; espnTeamName?: string; leagueSize?: number },
  ) {
    return this.draftsService.createDraft(
      req.user.sub,
      req.user.username,
      body.leagueId,
      body.sport,
      body.espnTeamName,
      body.leagueSize,
    );
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

  @Post('drafts/:id/complete')
  async completeDraft(@Req() req: any, @Param('id') id: string) {
    await this.draftsService.completeDraft(req.user.sub, id);
    return { ok: true };
  }

  // --- Pick reporting (called by injected script — authenticated by shared secret) ---

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 300 } })
  @Post('picks')
  async handlePick(
    @Headers('x-pick-secret') secret: string,
    @Body() body: PickDto,
  ) {
    const expected = process.env.PICK_SECRET;
    if (expected && secret !== expected) {
      throw new ForbiddenException('Invalid pick secret');
    }
    await this.draftsService.processPick(body);
    return { ok: true };
  }
}
