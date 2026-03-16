import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Draft, DraftStatus } from '../entities/draft.entity';
import { Job, JobStatus, JobPhase } from '../entities/job.entity';
import { User } from '../entities/user.entity';
import { SheetsService } from '../sheets/sheets.service';

@Injectable()
export class LiveDraftService {
  private readonly logger = new Logger(LiveDraftService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sheetsService: SheetsService,
    @InjectRepository(Draft) private draftRepo: Repository<Draft>,
    @InjectRepository(Job) private jobRepo: Repository<Job>,
    @InjectRepository(User) private userRepo: Repository<User>,
  ) {}

  /**
   * Cancel any active drafts for all users, provision new sheets for both,
   * and set jobs to RUNNING/draft_live so the frontend shows "live" state.
   * Returns the leagueId and sheetUrls for each user.
   */
  async initialize(leagueId: string): Promise<{ users: Array<{ username: string; sheetUrl: string | null }> }> {
    const u1 = this.config.get<string>('USER1_USERNAME') || 'kevin';
    const u2 = this.config.get<string>('USER2_USERNAME') || 'john';
    const espnTeams: Record<string, string> = {
      [u1]: this.config.get<string>('USER1_ESPN_TEAM_NAME') || 'Sonnys Nuts',
      [u2]: this.config.get<string>('USER2_ESPN_TEAM_NAME') || 'Enzo The Bakers',
    };
    const leagueSize = parseInt(this.config.get<string>('LEAGUE_SIZE') || '12', 10);
    const templateId = this.config.get<string>('SHEET_TEMPLATE_ID');

    const results: Array<{ username: string; sheetUrl: string | null }> = [];

    for (const username of [u1, u2]) {
      const user = await this.userRepo.findOne({ where: { username } });
      if (!user) {
        this.logger.warn(`User not found: ${username} — skipping`);
        continue;
      }

      // Cancel any existing active drafts + jobs for this user
      const activeDrafts = await this.draftRepo.find({
        where: { userId: user.id, status: DraftStatus.ACTIVE },
      });
      for (const d of activeDrafts) {
        await this.jobRepo
          .createQueryBuilder()
          .update(Job)
          .set({ status: JobStatus.CANCELED })
          .where('draftId = :draftId AND status IN (:...statuses)', {
            draftId: d.id,
            statuses: [JobStatus.QUEUED, JobStatus.RUNNING],
          })
          .execute();
        d.status = DraftStatus.CANCELED;
        await this.draftRepo.save(d);
        this.logger.log(`Canceled draft ${d.id} for user ${username}`);
      }

      // Provision a new sheet
      let sheetUrl: string | null = null;
      if (templateId) {
        const draftName = `DraftPilot Live – ${leagueId} (${username})`;
        sheetUrl = await this.sheetsService.duplicateSheet(templateId, draftName);
      }

      // Create a new draft record
      const draft = await this.draftRepo.save(
        this.draftRepo.create({
          userId: user.id,
          leagueId,
          sport: 'baseball',
          sheetUrl: sheetUrl ?? undefined,
          espnTeamName: espnTeams[username] ?? null,
          leagueSize,
        }),
      ) as Draft;

      // Create a job already set to RUNNING/draft_live (no worker needed)
      await this.jobRepo.save(
        this.jobRepo.create({
          draftId: draft.id,
          userId: user.id,
          status: JobStatus.RUNNING,
          phase: JobPhase.DRAFT_LIVE,
          claimedAt: new Date(),
          startedAt: new Date(),
        }),
      );

      this.logger.log(`Initialized live draft for ${username}: draft=${draft.id}, sheet=${sheetUrl}`);
      results.push({ username, sheetUrl });
    }

    return { users: results };
  }

  /**
   * Return a ready-to-paste browser console snippet.
   * Embeds BACKEND_URL, PICK_SECRET, and leagueId from env/request.
   */
  getSnippet(leagueId: string): string {
    let backendUrl = this.config.get<string>('BACKEND_URL') || '';
    // Ensure the URL has a protocol — without it browsers treat it as a relative path
    if (backendUrl && !backendUrl.startsWith('http')) {
      backendUrl = 'https://' + backendUrl;
    }
    backendUrl = backendUrl.replace(/\/+$/, '');
    const pickSecret = this.config.get<string>('PICK_SECRET') || '';

    // The snippet is observer-only. Initialization (sheet provisioning + job setup)
    // is done by the admin UI before the snippet is fetched, so no auth is needed here.
    return `(function liveDraftSnippet() {
  const BACKEND_URL = ${JSON.stringify(backendUrl)};
  const LEAGUE_ID   = ${JSON.stringify(leagueId)};
  const PICK_SECRET = ${JSON.stringify(pickSecret)};
  const SESSION_ID  = "live-" + LEAGUE_ID;

  const headers = { "Content-Type": "application/json" };
  if (PICK_SECRET) headers["X-Pick-Secret"] = PICK_SECRET;

  const targetNode = document.querySelector(".pa3");
  if (!targetNode) {
    console.error("[DraftHelper] Could not find draft log container (.pa3). Are you in the draft room?");
    return;
  }

  const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
      if (mutation.type !== "childList" || !mutation.addedNodes.length) continue;
      const node = mutation.addedNodes[0];
      try {
        const container = node.childNodes[0]?.childNodes[1];
        if (!container) continue;

        let name     = container.childNodes[0]?.innerText || "";
        let team     = container.childNodes[2]?.innerText || "";
        let position = container.childNodes[4]?.innerText || "";

        name = name.split(" ").slice(0, 3).join(" ").trim();
        team = team.toUpperCase();

        let pickerTeam = "";
        try {
          const headerNode = node.childNodes[0]?.childNodes[0];
          pickerTeam = (headerNode?.innerText || "").trim();
          if (/round|pick\\s+\\d/i.test(pickerTeam)) pickerTeam = "";
        } catch { pickerTeam = ""; }

        fetch(BACKEND_URL + "/picks", {
          method: "POST",
          headers,
          body: JSON.stringify({
            sessionId: SESSION_ID,
            leagueId: LEAGUE_ID,
            player: name,
            team,
            position,
            pickerTeam: pickerTeam || undefined,
          }),
        })
          .then(r => console.log("[DraftHelper] Pick sent:", name, r.status))
          .catch(err => console.error("[DraftHelper] Error posting pick:", name, err));
      } catch (err) {
        console.error("[DraftHelper] Error parsing mutation:", err);
      }
    }
  });

  observer.observe(targetNode, { attributes: true, childList: true, subtree: true });
  console.log("[DraftHelper] Observer started for league", LEAGUE_ID, "watching .pa3");
})();`;
  }
}
