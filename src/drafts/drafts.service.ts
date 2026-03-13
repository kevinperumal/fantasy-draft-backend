import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PickDto } from './drafts.controller';
import { SheetsService } from '../sheets/sheets.service';
import { Draft, DraftStatus } from '../entities/draft.entity';
import { Job, JobStatus } from '../entities/job.entity';

@Injectable()
export class DraftsService {
  private readonly logger = new Logger(DraftsService.name);

  constructor(
    private readonly sheetsService: SheetsService,
    private readonly config: ConfigService,
    @InjectRepository(Draft) private draftRepo: Repository<Draft>,
    @InjectRepository(Job) private jobRepo: Repository<Job>,
  ) {}

  async processPick(pick: PickDto) {
    const { player, team, position, sessionId, leagueId } = pick;
    this.logger.log(`Processing pick: ${player} / ${team} / ${position} (session: ${sessionId}, league: ${leagueId})`);

    let spreadsheetId: string | undefined;
    if (leagueId) {
      const draft = await this.draftRepo.findOne({
        where: { leagueId, status: DraftStatus.ACTIVE },
      });
      if (draft?.sheetUrl) {
        const match = draft.sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/);
        spreadsheetId = match?.[1];
      }
    }

    await this.sheetsService.highlightPlayer(player, team, position, spreadsheetId);
  }

  async createDraft(userId: string, leagueId: string, sport = 'baseball') {
    // Enforce one active draft per user
    const existing = await this.draftRepo.findOne({
      where: { userId, status: DraftStatus.ACTIVE },
    });
    if (existing) {
      throw new ConflictException('You already have an active draft');
    }

    // Optionally provision a sheet by duplicating the template
    let sheetUrl: string | null = null;
    const templateId = this.config.get<string>('SHEET_TEMPLATE_ID');
    if (templateId) {
      const draftName = `DraftPilot – ${leagueId} (${new Date().toLocaleDateString()})`;
      sheetUrl = await this.sheetsService.duplicateSheet(templateId, draftName);
    }

    // Create the draft record
    const draftEntity = this.draftRepo.create({
      userId,
      leagueId,
      sport,
      sheetUrl: sheetUrl ?? undefined,
    });
    const draft = await this.draftRepo.save(draftEntity) as Draft;

    // Enqueue a job for the worker to claim
    const jobEntity = this.jobRepo.create({ draftId: draft.id, userId });
    const job = await this.jobRepo.save(jobEntity) as Job;

    return { draft, job };
  }

  async getActiveDraft(userId: string): Promise<{ draft: Draft; job: Job | null } | null> {
    const draft = await this.draftRepo.findOne({
      where: { userId, status: DraftStatus.ACTIVE },
    });
    if (!draft) return null;

    // Return the most recent job for this draft
    const job = await this.jobRepo.findOne({
      where: { draftId: draft.id },
      order: { createdAt: 'DESC' },
    });

    return { draft, job };
  }

  async cancelDraft(userId: string, draftId: string) {
    const draft = await this.draftRepo.findOne({ where: { id: draftId, userId } });
    if (!draft) throw new NotFoundException('Draft not found');

    // Cancel any non-terminal jobs
    await this.jobRepo
      .createQueryBuilder()
      .update(Job)
      .set({ status: JobStatus.CANCELED })
      .where('draftId = :draftId AND status IN (:...statuses)', {
        draftId,
        statuses: [JobStatus.QUEUED, JobStatus.RUNNING],
      })
      .execute();

    draft.status = DraftStatus.CANCELED;
    await this.draftRepo.save(draft);
  }
}
