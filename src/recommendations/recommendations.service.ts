import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Anthropic from '@anthropic-ai/sdk';
import { SheetsService } from '../sheets/sheets.service';
import { Draft, DraftStatus } from '../entities/draft.entity';
import { PickRecord } from '../entities/pick.entity';

// ─── League configuration ─────────────────────────────────────────────────────
// Roster targets for this specific 12-team ESPN league.
// C×1, 1B×1, 2B×1, 3B×1, SS×1, OF×4, P×9 + flex slots (MI, CI, UTIL, DH, BN).
const ROSTER_TARGETS: Record<string, number> = {
  C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 4, P: 9,
};
const TOTAL_ROSTER_SIZE = 25;

// ─── Name normalization ───────────────────────────────────────────────────────
// Handles mismatches like "C.J." vs "CJ", "Jr." suffix, extra whitespace.
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, '')            // C.J. → cj
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '') // strip name suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Player metadata from spreadsheet ────────────────────────────────────────
// Column layout (confirmed from sheet): A=RotoV, B=Player, C=Pro Team,
// D=Position, E=ESPN Draft Room rank, F=ADP, G=Pitcher flag, H=Closer Rank

export interface PlayerMeta {
  name: string;
  proTeam: string;
  position: string;
  rotowireRank: number;
  espnRank: number;
  adp: number;
  isPitcher: boolean;
  closerRank: number | null;
}

function colIndex(envKey: string, defaultVal: number): number {
  const v = process.env[envKey];
  return v !== undefined ? parseInt(v, 10) : defaultVal;
}

function parsePlayerRow(row: string[]): PlayerMeta | null {
  const COL_RW_RANK   = colIndex('SHEET_COL_ROTOWIRE_RANK', 0);
  const COL_NAME      = colIndex('SHEET_COL_NAME', 1);
  const COL_PRO_TEAM  = colIndex('SHEET_COL_NFL_TEAM', 2);
  const COL_POSITION  = colIndex('SHEET_COL_POSITION', 3);
  const COL_ESPN_RANK = colIndex('SHEET_COL_ESPN_RANK', 4);
  const COL_ADP       = colIndex('SHEET_COL_ADP', 5);
  const COL_PITCHER   = colIndex('SHEET_COL_PITCHER', 6);
  const COL_CLOSER    = colIndex('SHEET_COL_CLOSER_RANK', 7);

  const name = row[COL_NAME]?.trim();
  if (!name) return null;

  const rawPosition = row[COL_POSITION]?.trim().toUpperCase() || '';
  const pitcherFlag = row[COL_PITCHER]?.trim();
  const isPitcher = ['SP', 'RP', 'P'].includes(rawPosition) || pitcherFlag === '1';

  return {
    name,
    proTeam: row[COL_PRO_TEAM]?.trim() || '',
    position: rawPosition,
    rotowireRank: parseFloat(row[COL_RW_RANK]) || 9999,
    espnRank: parseFloat(row[COL_ESPN_RANK]) || 9999,
    adp: parseFloat(row[COL_ADP]) || 9999,
    isPitcher,
    closerRank: row[COL_CLOSER] ? parseFloat(row[COL_CLOSER]) : null,
  };
}

// ─── Position normalization ───────────────────────────────────────────────────

function normalizePosition(pos: string): string {
  const p = (pos || '').toUpperCase();
  if (['LF', 'CF', 'RF', 'OF'].includes(p)) return 'OF';
  if (['SP', 'RP', 'P'].includes(p)) return 'P';
  return p; // C, 1B, 2B, 3B, SS, DH stay as-is
}

// ─── Roster needs computation ─────────────────────────────────────────────────

interface RosterNeeds {
  openNeeds: string[];          // e.g. ["OF (need 3 more)", "P (need 7 more)"]
  rosterByPosition: Record<string, number>;
  totalPicked: number;
  remainingRosterSlots: number;
}

function computeRosterNeeds(roster: PlayerMeta[]): RosterNeeds {
  const rosterByPosition: Record<string, number> = {};
  for (const p of roster) {
    const pos = normalizePosition(p.position);
    rosterByPosition[pos] = (rosterByPosition[pos] || 0) + 1;
  }

  const openNeeds: string[] = [];
  for (const [pos, target] of Object.entries(ROSTER_TARGETS)) {
    const have = rosterByPosition[pos] || 0;
    const need = target - have;
    if (need > 0) openNeeds.push(`${pos} (need ${need} more)`);
  }
  // If all primary slots filled, mention flex
  if (openNeeds.length === 0 && roster.length < TOTAL_ROSTER_SIZE) {
    openNeeds.push('Flex/bench depth');
  }

  return {
    openNeeds,
    rosterByPosition,
    totalPicked: roster.length,
    remainingRosterSlots: TOTAL_ROSTER_SIZE - roster.length,
  };
}

// ─── Snake draft pick calculator ──────────────────────────────────────────────

function nextPickInSnakeDraft(draftSlot: number, leagueSize: number, afterPick: number): number {
  let round = 1;
  while (true) {
    const pick =
      round % 2 === 1
        ? (round - 1) * leagueSize + draftSlot
        : round * leagueSize - draftSlot + 1;
    if (pick > afterPick) return pick;
    round++;
    if (round > 50) return afterPick + leagueSize;
  }
}

// ─── Deterministic feature computation ───────────────────────────────────────

interface CandidateFeatures {
  player: PlayerMeta;
  valueVsEspn: number;        // espnRank - rotowireRank; positive = ESPN undervalues
  valueVsAdp: number;         // adp - rotowireRank; positive = ADP undervalues
  adpFromNow: number;         // adp - currentPick; how many picks until ADP
  urgencyScore: number;       // 0–100
  likelySurvives: boolean;    // survives until team's next pick
  fillsNeed: boolean;
  needDeficit: number;        // how far below roster target this position is (0 if not needed)
  playersAheadAtPosition: number;
}

function computeFeatures(
  player: PlayerMeta,
  currentPick: number,
  picksUntilNext: number | null,
  rosterByPosition: Record<string, number>,
  availableByPosition: Map<string, PlayerMeta[]>,
): CandidateFeatures {
  const pos = normalizePosition(player.position);
  const valueVsEspn = player.espnRank - player.rotowireRank;
  const valueVsAdp = player.adp - player.rotowireRank;
  const adpFromNow = player.adp - currentPick;

  // Urgency score
  let urgencyScore = 50;
  if (picksUntilNext !== null && picksUntilNext > 0) {
    if (adpFromNow <= 0) urgencyScore = 100;
    else if (adpFromNow < picksUntilNext * 0.5) urgencyScore = 90;
    else if (adpFromNow < picksUntilNext) urgencyScore = 75;
    else if (adpFromNow < picksUntilNext * 1.5) urgencyScore = 40;
    else urgencyScore = 20;
  }
  // ESPN visibility / hidden value bump.
  // Always apply when Rotowire values the player significantly above ESPN's room rank —
  // these players are undervalued by the draft room regardless of current pick position.
  if (valueVsEspn >= 20) urgencyScore = Math.min(100, urgencyScore + 20);
  else if (valueVsEspn >= 10) urgencyScore = Math.min(100, urgencyScore + 10);
  // Extra bump if the player is now appearing near the current pick in ESPN (window closing)
  if (player.espnRank < currentPick + 10 && valueVsEspn >= 5) {
    urgencyScore = Math.min(100, urgencyScore + 10);
  }
  // Closer bonus: saves are scarce, closers disappear fast
  if (player.closerRank !== null && player.closerRank <= 5) {
    urgencyScore = Math.min(100, urgencyScore + 10);
  }

  const likelySurvives = picksUntilNext !== null
    ? adpFromNow > picksUntilNext * 1.3
    : adpFromNow > 10;

  const target = ROSTER_TARGETS[pos] ?? 0;
  const have = rosterByPosition[pos] ?? 0;
  const needDeficit = Math.max(0, target - have);
  const fillsNeed = needDeficit > 0;

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
    needDeficit,
    playersAheadAtPosition,
  };
}

// ─── Position run detection ───────────────────────────────────────────────────

function detectPositionRuns(recentPicks: PickRecord[]): string[] {
  const counts: Record<string, number> = {};
  const last10 = recentPicks.slice(-10);
  for (const p of last10) {
    const pos = normalizePosition(p.position || '');
    if (!pos) continue;
    counts[pos] = (counts[pos] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, n]) => n >= 3)
    .map(([pos]) => pos);
}

// ─── AI prompt ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a fantasy baseball draft advisor for DraftPilot, advising on a 12-team ESPN Head-to-Head snake draft.

League roster structure: C×1, 1B×1, 2B×1, 3B×1, SS×1, MI×1 (2B/SS flex), CI×1 (1B/3B flex), OF×4, DH×1, UTIL×1, P×9, BN×4. Total: 25 spots.
Scoring: R, HR, RBI, SB, AVG / K, W, SV, ERA, WHIP.

Rules:
- Use ONLY the structured data provided. Do not invent stats, rankings, or facts from outside this request.
- Rotowire rank is the primary value signal and MUST be considered in every recommendation.
- ESPN Draft Room rank shows where a player appears in the draft room — players ranked higher (lower number) are more visible to other drafters and are more at risk of being taken soon.
- A player with a high Rotowire value but a low ESPN room visibility (high ESPN rank number) is a hidden value that may enter other drafters' radar later — but be careful, the window can close quickly.
- Pitchers are scarce (9 needed). Balance SP/RP value with injury risk.
- Closers are extremely scarce — if a top closer is available and your save slot is not filled, that's urgent.
- Explain WHY a player should be taken NOW vs later using the actual numbers provided.
- Be concise: explanations should be 1-3 sentences.

Respond with a single valid JSON object. Output JSON only — no markdown, no code fences:
{
  "topPick": { "player": string, "position": string, "rotowireRank": number, "explanation": string },
  "alternatives": [{ "player": string, "position": string, "rotowireRank": number, "reason": string }],
  "likelyGone": [{ "player": string, "position": string, "reason": string }],
  "canWait": [{ "player": string, "position": string, "reason": string }]
}
Limit alternatives to 3, likelyGone to 3, canWait to 3.`;

function buildUserMessage(
  teamName: string,
  leagueSize: number,
  currentPick: number,
  nextPick: number | null,
  picksUntilNext: number | null,
  draftSlot: number | null,
  roster: PlayerMeta[],
  needs: RosterNeeds,
  positionRuns: string[],
  candidates: CandidateFeatures[],
): string {
  const rosterText = roster.length
    ? roster.map((p) => `  - ${p.name} (${p.position} | ${p.proTeam} | RW #${p.rotowireRank})`).join('\n')
    : '  (no picks yet)';

  const candidateText = candidates
    .map((c) => {
      const espnNote =
        c.valueVsEspn >= 15
          ? ` ← ESPN undervalues by ${c.valueVsEspn} spots (rising radar risk)`
          : c.valueVsEspn >= 8
            ? ` ← moderate ESPN undervalue (+${c.valueVsEspn})`
            : '';
      const closerNote = c.player.closerRank !== null ? ` | Closer rank: #${c.player.closerRank}` : '';
      return [
        `### ${c.player.name} (${c.player.position} | ${c.player.proTeam})`,
        `  RW #${c.player.rotowireRank} | ESPN room #${c.player.espnRank}${espnNote} | ADP ${c.player.adp.toFixed(1)}${closerNote}`,
        `  vs ESPN: ${c.valueVsEspn > 0 ? '+' : ''}${c.valueVsEspn} | vs ADP: ${c.valueVsAdp > 0 ? '+' : ''}${c.valueVsAdp.toFixed(1)} | ADP from now: ${c.adpFromNow.toFixed(1)}`,
        `  Urgency: ${c.urgencyScore}/100 | Survives to next pick: ${c.likelySurvives ? 'YES' : 'NO — AT RISK'}`,
        `  Fills roster need: ${c.fillsNeed ? `YES (need ${c.needDeficit} more ${normalizePosition(c.player.position)})` : 'no'} | Stronger ${c.player.position} still available: ${c.playersAheadAtPosition}`,
      ]
        .join('\n');
    })
    .join('\n\n');

  return `## Draft Context
- Team: ${teamName}
- League: 12-team ESPN H2H (NCL), snake draft
- Current overall pick: #${currentPick}
- Your draft slot: ${draftSlot ?? 'unknown (not yet determined)'}
- Your next pick: ${nextPick ? `#${nextPick} (${picksUntilNext} picks away)` : 'unknown'}

## Your Roster (${needs.totalPicked} / ${TOTAL_ROSTER_SIZE} picks made, ${needs.remainingRosterSlots} slots remaining)
${rosterText}

## Open Roster Needs
${needs.openNeeds.length ? needs.openNeeds.join(', ') : 'All primary positions covered — focus on depth/best available'}

## Position Run Alert
${positionRuns.length ? `Recent picks show a run on: ${positionRuns.join(', ')} — other teams are loading up on these` : 'No significant position runs detected'}

## Candidate Players (${candidates.length} shown, sorted by urgency)
${candidateText}`;
}

// ─── Result types ──────────────────────────────────────────────────────────────

export interface RecommendationResult {
  generatedAt: string;
  context: {
    teamName: string;
    currentPick: number;
    nextPick: number | null;
    picksUntilNext: number | null;
    rosterCount: number;
    openNeeds: string[];
  };
  topPick: { player: string; position: string; rotowireRank: number; explanation: string } | null;
  alternatives: { player: string; position: string; rotowireRank: number; reason: string }[];
  likelyGone: { player: string; position: string; reason: string }[];
  canWait: { player: string; position: string; reason: string }[];
  error?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

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

  // Resolve best spreadsheet ID for this user, then reload.
  // Order: active draft sheet → SHEET_TEMPLATE_ID env → SHEETS_SPREADSHEET_ID env
  async reloadCacheForUser(userId: string): Promise<number> {
    const draft = await this.draftRepo.findOne({
      where: { userId, status: DraftStatus.ACTIVE },
    });
    const draftSheetId = draft?.sheetUrl?.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
    const spreadsheetId =
      draftSheetId ||
      process.env.SHEET_TEMPLATE_ID ||
      process.env.SHEETS_SPREADSHEET_ID ||
      undefined;
    return this.reloadCache(spreadsheetId);
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
    if (!draft) return this.errorResult('No active draft found');

    const teamName = draft.espnTeamName || 'Your Team';
    const leagueSize = draft.leagueSize || 12;

    // 2. All picks for this draft
    const allPicks = await this.pickRepo.find({
      where: { draftId: draft.id },
      order: { overallPick: 'ASC' },
    });

    const currentPick = allPicks.length + 1;

    // 3. Derive draft slot from user's first pick
    let draftSlot: number | null = null;
    if (draft.espnTeamName) {
      const userFirstPick = allPicks.find(
        (p) =>
          p.pickerTeam &&
          p.pickerTeam.toLowerCase().includes(draft.espnTeamName!.toLowerCase()),
      );
      if (userFirstPick?.overallPick) draftSlot = userFirstPick.overallPick;
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
        'No player data loaded. Configure SHEETS_SPREADSHEET_ID or SHEET_TEMPLATE_ID, then call POST /recommendations/cache/reload.',
      );
    }

    // 5. Available players (not yet drafted)
    const draftedNames = new Set(allPicks.map((p) => normalizeName(p.player)));
    const available = allPlayers.filter((p) => !draftedNames.has(normalizeName(p.name)));

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
          .map((p) => normalizeName(p.player)),
      );
      roster.push(...allPlayers.filter((p) => userPickNames.has(normalizeName(p.name))));
    }

    // 7. Compute roster needs
    const needs = computeRosterNeeds(roster);

    // 8. Index available players by normalized position
    const availableByPosition = new Map<string, PlayerMeta[]>();
    for (const p of available) {
      const pos = normalizePosition(p.position);
      if (!availableByPosition.has(pos)) availableByPosition.set(pos, []);
      availableByPosition.get(pos)!.push(p);
    }

    // 9. Build candidate set:
    //    - Top 25 by Rotowire rank (value floor)
    //    - Top 5 per unfilled position (need floor)
    const topByRw = [...available].sort((a, b) => a.rotowireRank - b.rotowireRank).slice(0, 25);
    const needCandidates: PlayerMeta[] = [];
    for (const need of needs.openNeeds) {
      const pos = need.split(' ')[0]; // e.g. "OF" from "OF (need 3 more)"
      const atPos = (availableByPosition.get(pos) || [])
        .sort((a, b) => a.rotowireRank - b.rotowireRank)
        .slice(0, 5);
      needCandidates.push(...atPos);
    }
    const candidateSet = [
      ...new Map([...topByRw, ...needCandidates].map((p) => [p.name, p])).values(),
    ];

    // 10. Compute features and sort by urgency
    const withFeatures = candidateSet
      .map((p) =>
        computeFeatures(p, currentPick, picksUntilNext, needs.rosterByPosition, availableByPosition),
      )
      .sort((a, b) => b.urgencyScore - a.urgencyScore)
      .slice(0, 20);

    // 11. Position run detection
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
      needs,
      positionRuns,
      withFeatures,
    );

    try {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not set');
      }
      const model = process.env.AI_MODEL || 'claude-sonnet-4-6';
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text);

      return {
        generatedAt: new Date().toISOString(),
        context: {
          teamName,
          currentPick,
          nextPick,
          picksUntilNext,
          rosterCount: roster.length,
          openNeeds: needs.openNeeds,
        },
        topPick: parsed.topPick ?? null,
        alternatives: parsed.alternatives ?? [],
        likelyGone: parsed.likelyGone ?? [],
        canWait: parsed.canWait ?? [],
      };
    } catch (err: any) {
      this.logger.error(`AI call failed: ${err.message}`);
      return this.errorResult(`AI call failed: ${err.message}`);
    }
  }

  private errorResult(msg: string): RecommendationResult {
    return {
      generatedAt: new Date().toISOString(),
      context: { teamName: '', currentPick: 0, nextPick: null, picksUntilNext: null, rosterCount: 0, openNeeds: [] },
      topPick: null,
      alternatives: [],
      likelyGone: [],
      canWait: [],
      error: msg,
    };
  }
}
