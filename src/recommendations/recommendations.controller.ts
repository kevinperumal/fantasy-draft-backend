import { Controller, Post, Req } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  // Generate a recommendation for the authenticated user's active draft.
  @Post('generate')
  generate(@Req() req: any) {
    return this.recommendationsService.generate(req.user.sub);
  }

  // Force-reload the player cache from the fallback spreadsheet (SHEETS_SPREADSHEET_ID).
  // To reload a draft-specific sheet, call generate — it auto-loads on first call.
  @Post('cache/reload')
  async reloadCache() {
    const count = await this.recommendationsService.reloadCache();
    return { ok: true, players: count };
  }
}
