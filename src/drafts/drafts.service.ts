import { Injectable, Logger } from '@nestjs/common';
import { PickDto } from './drafts.controller';
import { SheetsService } from '../sheets/sheets.service';

@Injectable()
export class DraftsService {
  private readonly logger = new Logger(DraftsService.name);

  constructor(private readonly sheetsService: SheetsService) {}

  async processPick(pick: PickDto) {
    const { player, team, position, sessionId } = pick;
    this.logger.log(
      `Processing pick: ${player} / ${team} / ${position} (session: ${sessionId})`,
    );

    await this.sheetsService.highlightPlayer(player, team, position);
  }
}
