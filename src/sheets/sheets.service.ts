import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';

// Normalise a player name for fuzzy matching
function normName(s: string): string {
  return s.toLowerCase().replace(/\./g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/gi, '').replace(/\s+/g, ' ').trim();
}

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private sheets: sheets_v4.Sheets | null = null;
  private auth: any = null;

  private readonly fallbackSpreadsheetId = process.env.SHEETS_SPREADSHEET_ID || '';
  private readonly sheetId = parseInt(process.env.SHEETS_SHEET_ID || '0', 10);
  private readonly highlightColumnCount = 8;

  // Per-spreadsheet caches so we never re-read the sheet on every pick.
  // Key: spreadsheetId
  // tabIdCache: the integer sheet tab ID (from spreadsheets.get metadata)
  // rowCache: Map of `normName(player)|TEAM` → 0-based rowIndex
  private tabIdCache = new Map<string, number>();
  private rowCache = new Map<string, Map<string, number>>();

  constructor() {
    this.initClient()
      .then(() => this.logger.log('Google Sheets client initialized'))
      .catch((err) => this.logger.error('Error initializing Google Sheets client', err));
  }

  private async initClient() {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

    if (clientId && clientSecret && refreshToken) {
      const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oAuth2Client.setCredentials({ refresh_token: refreshToken });
      this.auth = oAuth2Client;
      this.sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
      this.logger.log('Google Sheets client initialized (OAuth2 user credentials)');
      return;
    }

    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      this.logger.warn('No Google credentials set — Sheets disabled');
      return;
    }

    const credentials = JSON.parse(raw);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    this.auth = await auth.getClient();
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    this.logger.log('Google Sheets client initialized (service account)');
  }

  // Duplicate a template spreadsheet and return the URL of the new sheet.
  // Returns null if the Drive API call fails (e.g. missing drive scope).
  async duplicateSheet(templateId: string, name: string): Promise<string | null> {
    if (!this.auth) {
      this.logger.error('Auth client not initialized — cannot duplicate sheet');
      return null;
    }
    try {
      const drive = google.drive({ version: 'v3', auth: this.auth });
      const folderId = process.env.SHEETS_FOLDER_ID;
      const res = await drive.files.copy({
        fileId: templateId,
        requestBody: {
          name,
          ...(folderId ? { parents: [folderId] } : {}),
        },
      });
      const newId = res.data.id;
      if (!newId) return null;
      this.logger.log(`Duplicated sheet template → ${newId}`);
      return `https://docs.google.com/spreadsheets/d/${newId}/edit`;
    } catch (err: any) {
      this.logger.error(`Failed to duplicate sheet: ${err.message}`);
      return null;
    }
  }

  // Read all player rows from the sheet. Returns raw string arrays (one per row).
  // Uses the spreadsheetId if provided, otherwise falls back to SHEETS_SPREADSHEET_ID.
  // Skips the header row by using the SHEET_PLAYER_RANGE env var (default A2:H).
  async readPlayerRows(spreadsheetId?: string): Promise<string[][]> {
    if (!this.sheets) {
      this.logger.warn('Sheets client not initialized — cannot read player rows');
      return [];
    }
    const targetId = spreadsheetId || this.fallbackSpreadsheetId;
    if (!targetId) {
      this.logger.warn('No spreadsheet ID available — skipping player row read');
      return [];
    }
    const range = process.env.SHEET_PLAYER_RANGE || 'A2:H';
    try {
      const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: targetId, range });
      return (res.data.values || []) as string[][];
    } catch (err: any) {
      this.logger.error(`Failed to read player rows: ${err.message}`);
      return [];
    }
  }

  // Resolve the integer tab ID for a spreadsheet, caching after the first lookup.
  private async resolveTabId(spreadsheetId: string, isDraftSheet: boolean): Promise<number> {
    if (!isDraftSheet) return this.sheetId; // legacy fallback uses env var
    if (this.tabIdCache.has(spreadsheetId)) return this.tabIdCache.get(spreadsheetId)!;
    const meta = await this.sheets!.spreadsheets.get({ spreadsheetId });
    const id = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
    this.tabIdCache.set(spreadsheetId, id);
    return id;
  }

  // Build (or return cached) name+team → rowIndex lookup for a spreadsheet.
  // One read per draft per deploy — never re-read during picks.
  private async resolveRowMap(spreadsheetId: string): Promise<Map<string, number>> {
    if (this.rowCache.has(spreadsheetId)) return this.rowCache.get(spreadsheetId)!;

    const res = await this.sheets!.spreadsheets.values.get({
      spreadsheetId,
      range: 'B:D',
    });
    const vals = (res.data.values || []) as string[][];
    const map = new Map<string, number>();
    for (let i = 0; i < vals.length; i++) {
      const nameCell = vals[i][0];
      const teamCell = vals[i][1];
      if (nameCell && teamCell) {
        map.set(`${normName(nameCell)}|${teamCell.toUpperCase()}`, i);
        // Also store original casing for exact-match lookup
        map.set(`${nameCell}|${teamCell.toUpperCase()}`, i);
      }
    }
    this.rowCache.set(spreadsheetId, map);
    this.logger.log(`Row cache built for ${spreadsheetId}: ${vals.length} rows`);
    return map;
  }

  // Evict caches for a spreadsheet (call when a new draft sheet is provisioned).
  evictCache(spreadsheetId: string) {
    this.tabIdCache.delete(spreadsheetId);
    this.rowCache.delete(spreadsheetId);
  }

  async highlightPlayer(player: string, team: string, position: string, spreadsheetId?: string) {
    if (!this.sheets) {
      this.logger.error('Sheets client not initialized yet');
      return;
    }
    const targetSpreadsheetId = spreadsheetId || this.fallbackSpreadsheetId;
    if (!targetSpreadsheetId) {
      this.logger.warn('No spreadsheet ID available — skipping highlight');
      return;
    }

    this.logger.log(`Highlighting player in sheet: ${player} / ${team} / ${position}`);

    const isDraftSheet = !!spreadsheetId;
    const [targetSheetId, rowMap] = await Promise.all([
      this.resolveTabId(targetSpreadsheetId, isDraftSheet),
      this.resolveRowMap(targetSpreadsheetId),
    ]);

    const teamUpper = team.toUpperCase();
    const normPlayer = normName(player);

    // Try exact key first, then normalized key
    let rowIndex = rowMap.get(`${player}|${teamUpper}`) ?? rowMap.get(`${normPlayer}|${teamUpper}`) ?? -1;

    // Fallback: prefix scan (handles cases where sheet has "First Last Jr" vs "First Last")
    if (rowIndex === -1) {
      for (const [key, idx] of rowMap) {
        const [keyName, keyTeam] = key.split('|');
        if (keyTeam === teamUpper && (keyName.includes(normPlayer) || normPlayer.includes(keyName))) {
          rowIndex = idx;
          break;
        }
      }
    }

    if (rowIndex === -1) {
      this.logger.warn(`Player not found in sheet: ${player} / ${team}`);
      return;
    }

    this.logger.log(`Found player at row index ${rowIndex} (1-based row ${rowIndex + 1})`);

    const request: sheets_v4.Schema$BatchUpdateSpreadsheetRequest = {
      requests: [
        {
          updateCells: {
            range: {
              sheetId: targetSheetId,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: this.highlightColumnCount,
            },
            rows: [
              {
                values: Array.from({ length: this.highlightColumnCount }).map(() => ({
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 0.4, blue: 0.4 },
                  },
                })),
              },
            ],
            fields: 'userEnteredFormat',
          },
        },
      ],
    };

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: targetSpreadsheetId,
      requestBody: request,
    });

    this.logger.log(`Highlighted row ${rowIndex + 1} for player ${player} / ${team}`);
  }
}
