import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private sheets: sheets_v4.Sheets;

  private readonly spreadsheetId = '1xOTF5J065gABOOVm930ANNcq0kGooZ6Ua7GdrY6b5sc';
  private readonly sheetId = 1138131281;
  private readonly highlightColumnCount = 8; // ucfSelectedRowIndex

  constructor() {
    this.initClient().then(() => {
      this.logger.log('Google Sheets client initialized');
    }).catch((err) => {
      this.logger.error('Error initializing Google Sheets client', err);
    });
  }

  private async initClient() {
    // These are your old credentials.json + token.json
    const credentialsPath = path.join(process.cwd(), 'credentials.json');
    const tokenPath = path.join(process.cwd(), 'token.json');

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0],
    );

    oAuth2Client.setCredentials(token);

    this.sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
  }

  async highlightPlayer(player: string, team: string, position: string) {
    if (!this.sheets) {
      this.logger.error('Sheets client not initialized yet');
      return;
    }

    this.logger.log(`Highlighting player in sheet: ${player} / ${team} / ${position}`);

    // 1) Read columns B:D to find the row
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

    // 2) Build a batchUpdate to color the row
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
                    backgroundColor: {
                      red: 1,
                      green: 0.4,
                      blue: 0.4,
                    },
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

    this.logger.log(
      `Highlighted row ${rowIndex + 1} for player ${player} / ${team}`,
    );
  }
}
