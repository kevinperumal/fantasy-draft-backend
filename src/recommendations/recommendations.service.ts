import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Anthropic from '@anthropic-ai/sdk';
import { SheetsService } from '../sheets/sheets.service';
import { Draft, DraftStatus } from '../entities/draft.entity';
import { PickRecord } from '../entities/pick.entity';

// ─── Player metadata from spreadsheet ───────────────────────────────────────

export interface PlayerMeta {
  name: string;
  nflTeam: string;
  position: string;
  rotowireRank: number;
  espnRank: number;
  adp: number;
  isPitcher: boolean;
  closerRank: number | null;
}

// Column indices into each spreadsheet row (0-based). All configurable via env.
function colIndex(envKey: string, defaultVal: number): number {
  const v = process.env[envKey];
  return v !== undefined ? parseInt(v, 10) : defaultVal;
}

function parsePlayerRow(row: string[]): PlayerMeta | null {
  const COL_RW_RANK   = colIndex('SHEET_COL_ROTOWIRE_RANK', 0);
  const COL_NAME      = colIndex('SHEET_COL_NAME', 1);
  const COL_NFL_TEAM  = colIndex('SHEET_COL_NFL_TEAM', 2);
  const COL_POSITION  = colIndex('SHEET_COL_POSITION', 3);
  const COL_ESPN_RANK = colIndex('SHEET_COL_ESPN_RANK', 4);
  const COL_ADP       = colIndex('SHEET_COL_ADP', 5);
  const COL_PITCHER   = colIndex('SHEET_COL_PITCHER', 6);
  const COL_CLOSER    = colIndex('SHEET_COL_CLOSER_RANK', 7);

  const name = row[COL_NAME]?.trim();
  if (!name) return null;

  return {
    name,
    nflTeam: row[COL_NFL_TEAM]?.trim() || '',
    position: row[COL_POSITION]?.trim() || '',
    rotowireRank: parseFloat(row[COL_RW_RANK]) || 9999,
    espnRank: parseFloat(row[COL_ESPN_RANK]) || 9999,
    adp: parseFloat(row[COL_ADP]) || 9999,
    isPitcher: ['SP', 'RP', 'P'].includes(row[COL_POSITION]?.trim().toUpperCase() || ''),
    closerRank: row[COL_CLOSER] ? parseFloat(row[COL_CLOSER]) : null,
  };
}

// ─── Candidate feature computation ──────────────────────────────────────────

interface CandidateFeatures {
  player: PlayerMeta;
  valueVsEspn: number;      // espnRank - rotowireRank (positive = undervalued by ESPN room)
  valueVsAdp: number;       // adp - rotowireRank (positive = undervalued vs ADP)
  adpFromNow: number;       // adp - currentPick (how many picks until ADP)
  urgencyScore: number;     // 0–100
  likelySurvives: boolean;  // survives until the team's next pick
  fillsNeed: boolean;
  playersAheadAtPosition: number; // stronger Rotowire players at same position still available
}

function computeFeatures(
  player: PlayerMeta,
  currentPick: number,
  nextPick: number | null,
  picksUntilNext: number | null,
  teamPositions: Set<string>,
  availableByPosition: Map<string, PlayerMeta[]>,
): CandidateFeatures {
  const valueVsEspn = player.espnRank - player.rotowireRank;
  const valueVsAdp = player.adp - player.rotowireRank;
  const adpFromNow = player.adp - currentPick;

  // Urgency: higher when adpFromNow is small relative to picksUntilNext
  let urgencyScore = 50;
  if (picksUntilNext !== null && picksUntilNext > 0) {
    if (adpFromNow <= 0) {
      urgencyScore = 100; // Already at or past ADP — very urgent
    } else if (adpFromNow < picksUntilNext * 0.5) {
      urgencyScore = 90;
    } else if (adpFromNow < picksUntilNext) {
      urgencyScore = 75;
    } else if (adpFromNow < picksUntilNext * 1.5) {
      urgencyScore = 40;
    } else {
      urgencyScore = 20; // Likely survives comfortably
    }
  }
  // ESPN visibility adds urgency: if ESPN room ranks player highly but Rotowire does too
  if (player.espnRank < currentPick + 5) urgencyScore = Math.min(100, urgencyScore + 15);

  const likelySurvives = picksUntilNext !== null
    ? adpFromNow > picksUntilNext * 1.2
    : adpFromNow > 8;

  const pos = normalizePosition(player.position);
  const fillsNeed = !teamPositions.has(pos);

  const positionPeers = availableByPosition.get(pos) || [];
  const playersAheadAtPosition = positionPeers.filter(
    (p) => p.rotowireRank < player.rotowireRank,
  ).length;

  return {
    player,
    valueVsEspn,
    valueVsAdp,
    adpFromNow,
    urgencyScore,
    likelySurvives,
    fillsNeed,
    playersAheadAtPosition,
  };
}

function normalizePosition(pos: string): string {
  const p = pos.toUpperCase();
  if (['LF', 'CF', 'RF', 'OF'].includes(p)) return 'OF';
  if (['SP', 'RP', 'P'].includes(p)) return 'P';
  return p;
}

// Snake draft: compute the next pick for a given draft slot
function nextPickInSnakeDraft(draftSlot: number, leagueSize: number, afterPick: number): number {
  let round = 1;
  while (true) {
    const pick =
      round % 2 === 1
        ? (round - 1) * leagueSize + draftSlot
        : round * leagueSize - draftSlot + 1;
    if (pick > afterPick) return pick;
    round++;
    if (round > 50) return afterPick + leagueSize; // safety fallback
  }
}

// Detect if a position run is happening in recent picks
function detectPositionRuns(recentPicks: PickRecord[]): string[] {
  const counts: Record<string, number> = {};
  const last8 = recentPicks.slice(-8);
  for (const p of last8) {
    const pos = normalizePosition(p.position || '');
    if (!pos) continue;
    counts[pos] = (counts[pos] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, n]) => n >= 3)
    .map(([pos]) => pos);
}

// ─── AI prompt ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a fantasy baseball draft advisor integrated into DraftPilot.

Rules:
- Use ONLY the structured data provided. Do not invent stats, ADP values, rankings, or baseball knowledge from outside this request.
- Rotowire rank is the primary value signal and MUST factor into every recommendation.
- Explain WHY a player should be taken NOW (timing, need, scarcity) vs later.
- Be concise: explanations should be 1-3 sentences.
- ESPN room rank matters: a player ranked highly by Rotowire but ranked lower by ESPN is a hidden value that may enter other drafters' radar soon.

Respond with a single valid JSON object matching this schema exactly:
{
  "topPick": { "player": string, "position": string, "rotowireRank": number, "explanation": string },
  "alternatives": [{ "player": string, "position": string, "rotowireRank": number, "reason": string }],
  "likelyGone": [{ "player": string, "position": string, "reason": string }],
  "canWait": [{ "player": string, "position": string, "reason": string }]
}
Limit alternatives to 3, likelyGone to 3, canWait to 3. Output JSON only — no markdown, no code fences.`;

function buildUserMessage(
  teamName: string,
  leagueSize: number,
  currentPick: number,
  nextPick: number | null,
  picksUntilNext: number | null,
  draftSlot: number | null,
  roster: PlayerMeta[],
  openNeeds: string[],
  positionRuns: string[],
  candidates: CandidateFeatures[],
): string {
  const rosterText = roster.length
    ? roster.map((p) => `  - ${p.name} (${p.position}, RW: #${p.rotowireRank})`).join('\n')
    : '  (no picks yet)';

  const candidateText = candidates
    .map((c) => {
      const espnNote =
        c.valueVsEspn >= 10
          ? ` [ESPN undervalues by ${c.valueVsEspn} spots — rising radar risk]`
          : c.valueVsEspn <= -10
            ? ` [ESPN overvalues vs Rotowire]`
            : '';
      return [
        `### ${c.player.name} (${c.player.position})`,
        `  Rotowire #${c.player.rotowireRank} | ESPN room #${c.player.espnRank}${espnNote} | ADP ${c.player.adp.toFixed(1)}`,
        `  Value vs ESPN: ${c.valueVsEspn > 0 ? '+' : ''}${c.valueVsEspn} | Value vs ADP: ${c.valueVsAdp > 0 ? '+' : ''}${c.valueVsAdp.toFixed(1)}`,
        `  ADP from current pick: ${c.adpFromNow.toFixed(1)} | Urgency: ${c.urgencyScore}/100 | Likely survives: ${c.likelySurvives ? 'YES' : 'NO — AT RISK'}`,
        `  Fills position need: ${c.fillsNeed ? 'YES' : 'no'} | Stronger players ahead at ${c.player.position}: ${c.playersAheadAtPosition}`,
        c.player.closerRank ? `  Closer rank: ${c.player.closerRank}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `## Draft Context
- Team: ${teamName}
- League size: ${leagueSize}
- Current overall pick: #${currentPick}
- Your draft slot: ${draftSlot ?? 'unknown'}
- Your next pick: ${nextPick ? `#${nextPick} (${picksUntilNext} picks away)` : 'unknown'}

## Your Roster (${roster.length} players)
${rosterText}

## Open Position Needs
${openNeeds.length ? openNeeds.join(', ') : 'All primary positions covered'}

## Position Run Alert
${positionRuns.length ? `Recent picks show a run on: ${positionRuns.join(', ')}` : 'No significant position runs detected'}

## Candidate Players (${candidates.length} players, sorted by urgency)
${candidateText}`;
}

// ─── Main service ─────────────────────────────────────────────────────────────

export interface RecommendationResult {
  generatedAt: string;
  context: {
    teamName: string;
    currentPick: number;
    nextPick: number | null;
    picksUntilNext: number | null;
    rosterCount: number;
  };
  topPick: { player: string; position: string; rotowireRank: number; explanation: string } | null;
  alternatives: { player: string; position: string; rotowireRank: number; reason: string }[];
  likelyGone: { player: string; position: string; reason: string }[];
  canWait: { player: string; position: string; reason: string }[];
  error?: string;
}

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);
  private readonly anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  });

  // In-memory player cache keyed by spreadsheetId (or 'default')
  private playerCache = new Map<string, PlayerMeta[]>();

  constructor(
    private readonly sheetsService: SheetsService,
    @InjectRepository(Draft) private draftRepo: Repository<Draft>,
    @InjectRepository(PickRecord) private pickRepo: Repository<PickRecord>,
  ) {}

  async reloadCache(spreadsheetId?: string): Promise<number> {
    const key = spreadsheetId || 'default';
    const rows = await this.sheetsService.readPlayerRows(spreadsheetId);
    const players = rows.map(parsePlayerRow).filter((p): p is PlayerMeta => p !== null);
    this.playerCache.set(key, players);
    this.logger.log(`Player cache loaded: ${players.length} players (key: ${key})`);
    return players.length;
  }

  private async getPlayerCache(spreadsheetId?: string): Promise<PlayerMeta[]> {
    const key = spreadsheetId || 'default';
    if (!this.playerCache.has(key)) {
      await this.reloadCache(spreadsheetId);
    }
    return this.playerCache.get(key) || [];
  }

  async generate(userId: string): Promise<RecommendationResult> {
    // 1. Get active draft
    const draft = await this.draftRepo.findOne({
      where: { userId, status: DraftStatus.ACTIVE },
    });
    if (!draft) {
      return this.errorResult('No active draft found');
    }

    const teamName = draft.espnTeamName || 'Your Team';
    const leagueSize = draft.leagueSize || 12;

    // 2. Get all picks for this draft
    const allPicks = await this.pickRepo.find({
      where: { draftId: draft.id },
      order: { overallPick: 'ASC' },
    });

    const currentPick = allPicks.length + 1; // next pick to be made

    // 3. Derive user's draft slot from their first pick
    let draftSlot: number | null = null;
    if (draft.espnTeamName) {
      const userFirstPick = allPicks.find(
        (p) => p.pickerTeam && p.pickerTeam.toLowerCase().includes(draft.espnTeamName!.toLowerCase()),
      );
      if (userFirstPick?.overallPick) {
        draftSlot = userFirstPick.overallPick;
      }
    }

    const nextPick = draftSlot
      ? nextPickInSnakeDraft(draftSlot, leagueSize, currentPick - 1)
      : null;
    const picksUntilNext = nextPick ? nextPick - currentPick : null;

    // 4. Load player cache
    const spreadsheetId = draft.sheetUrl?.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
    const allPlayers = await this.getPlayerCache(spreadsheetId);
    if (allPlayers.length === 0) {
      return this.errorResult(
        'No player data found. Ensure the spreadsheet is configured (SHEET_TEMPLATE_ID or SHEETS_SPREADSHEET_ID) and reload the cache.',
      );
    }

    // 5. Compute drafted player names (case-insensitive)
    const draftedNames = new Set(allPicks.map((p) => p.player.toLowerCase()));
    const available = allPlayers.filter((p) => !draftedNames.has(p.name.toLowerCase()));

    // 6. User's roster
    const roster: PlayerMeta[] = [];
    if (draft.espnTeamName) {
      const userPickNames = new Set(
        allPicks
          .filter(
            (p) =>
              p.pickerTeam &&
              p.pickerTeam.toLowerCase().includes(draft.espnTeamName!.toLowerCase()),
          )
          .map((p) => p.player.toLowerCase()),
      );
      for (const p of allPlayers) {
        if (userPickNames.has(p.name.toLowerCase())) roster.push(p);
      }
    }

    // 7. Team needs
    const teamPositions = new Set(roster.map((p) => normalizePosition(p.position)));
    const typicalNeeds = ['C', '1B', '2B', '3B', 'SS', 'OF', 'P'];
    const openNeeds = typicalNeeds.filter((pos) => !teamPositions.has(pos));

    // 8. Index available players by position
    const availableByPosition = new Map<string, PlayerMeta[]>();
    for (const p of available) {
      const pos = normalizePosition(p.position);
      if (!availableByPosition.has(pos)) availableByPosition.set(pos, []);
      availableByPosition.get(pos)!.push(p);
    }

    // 9. Build candidate set
    // Top 25 by Rotowire rank + top 5 per open need position (deduped)
    const topByRw = [...available].sort((a, b) => a.rotowireRank - b.rotowireRank).slice(0, 25);
    const needCandidates: PlayerMeta[] = [];
    for (const pos of openNeeds) {
      const atPos = (availableByPosition.get(pos) || [])
        .sort((a, b) => a.rotowireRank - b.rotowireRank)
        .slice(0, 5);
      needCandidates.push(...atPos);
    }
    const candidateSet = [
      ...new Map([...topByRw, ...needCandidates].map((p) => [p.name, p])).values(),
    ];

    // 10. Compute features for each candidate, sort by urgency
    const withFeatures = candidateSet
      .map((p) =>
        computeFeatures(p, currentPick, nextPick, picksUntilNext, teamPositions, availableByPosition),
      )
      .sort((a, b) => b.urgencyScore - a.urgencyScore)
      .slice(0, 20); // send top 20 to Claude

    // 11. Detect position runs
    const positionRuns = detectPositionRuns(allPicks);

    // 12. Call Claude
    const userMessage = buildUserMessage(
      teamName,
      leagueSize,
      currentPick,
      nextPick,
      picksUntilNext,
      draftSlot,
      roster,
      openNeeds,
      positionRuns,
      withFeatures,
    );

    let aiResult: RecommendationResult['topPick'] & {
      alternatives: RecommendationResult['alternatives'];
      likelyGone: RecommendationResult['likelyGone'];
      canWait: RecommendationResult['canWait'];
    };

    try {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not configured');
      }
      const model = process.env.AI_MODEL || 'claude-sonnet-4-6';
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text =
        response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text);
      aiResult = {
        ...parsed.topPick,
        alternatives: parsed.alternatives || [],
        likelyGone: parsed.likelyGone || [],
        canWait: parsed.canWait || [],
      };
    } catch (err: any) {
      this.logger.error(`AI call failed: ${err.message}`);
      return this.errorResult(`AI call failed: ${err.message}`);
    }

    return {
      generatedAt: new Date().toISOString(),
      context: {
        teamName,
        currentPick,
        nextPick,
        picksUntilNext,
        rosterCount: roster.length,
      },
      topPick: {
        player: aiResult.player,
        position: aiResult.position,
        rotowireRank: aiResult.rotowireRank,
        explanation: aiResult.explanation,
      },
      alternatives: aiResult.alternatives,
      likelyGone: aiResult.likelyGone,
      canWait: aiResult.canWait,
    };
  }

  private errorResult(msg: string): RecommendationResult {
    return {
      generatedAt: new Date().toISOString(),
      context: { teamName: '', currentPick: 0, nextPick: null, picksUntilNext: null, rosterCount: 0 },
      topPick: null,
      alternatives: [],
      likelyGone: [],
      canWait: [],
      error: msg,
    };
  }
}
