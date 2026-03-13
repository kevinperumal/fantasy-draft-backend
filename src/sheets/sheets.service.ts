import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private sheets: sheets_v4.Sheets | null = null;
  private auth: any = null;

  private readonly spreadsheetId = process.env.SHEETS_SPREADSHEET_ID || '';
  private readonly sheetId = parseInt(process.env.SHEETS_SHEET_ID || '0', 10);
  private readonly highlightColumnCount = 8;

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

  async highlightPlayer(player: string, team: string, position: string) {
    if (!this.sheets) {
      this.logger.error('Sheets client not initialized yet');
      return;
    }

    this.logger.log(`Highlighting player in sheet: ${player} / ${team} / ${position}`);

    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: 'B:D',
    });

    const vals = res.data.values || [];
    let rowIndex = -1;

    for (let i = 0; i < vals.length; i++) {
      const row = vals[i];
      const nameCell = row[0];
      const teamCell = row[1];
      if (nameCell && nameCell.includes(player) && teamCell === team) {
        rowIndex = i;
        break;
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
              sheetId: this.sheetId,
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
      spreadsheetId: this.spreadsheetId,
      requestBody: request,
    });

    this.logger.log(`Highlighted row ${rowIndex + 1} for player ${player} / ${team}`);
  }
}
