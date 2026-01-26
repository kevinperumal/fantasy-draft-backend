// src/worker.controller.ts
import { Body, Controller, Post } from '@nestjs/common';

@Controller('worker')
export class WorkerController {
  @Post('run')
  async runWorker(@Body() body: { leagueId: string; sport?: string }) {
    const { leagueId, sport = 'baseball' } = body;

    if (!leagueId) {
      return {
        error: 'leagueId is required',
      };
    }

    try {
      // This call goes to the Pi worker running on localhost:4000
      const res = await fetch('http://localhost:4000/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leagueId, sport }),
      });

      const data = await res.json().catch(() => ({}));

      return {
        ok: res.ok,
        status: res.status,
        workerResponse: data,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to reach worker: ${err instanceof Error ? err.message : err}`,
      };
    }
  }
}

