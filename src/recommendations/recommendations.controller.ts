import { Controller, Post, Req } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  @Post('generate')
  generate(@Req() req: any) {
    return this.recommendationsService.generate(req.user.sub);
  }

  // Reload player cache. Resolution order for spreadsheet ID:
  //   1. User's active draft sheetUrl
  //   2. SHEET_TEMPLATE_ID env var (the master rankings sheet)
  //   3. SHEETS_SPREADSHEET_ID env var (legacy fallback)
  @Post('cache/reload')
  async reloadCache(@Req() req: any) {
    const count = await this.recommendationsService.reloadCacheForUser(req.user.sub);
    return { ok: true, players: count };
  }
}
