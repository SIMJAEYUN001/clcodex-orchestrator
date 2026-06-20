import { createServer, type Socket } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommandEvent } from './types.js';
import { Store } from './store.js';

const eventSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid().optional(),
  type: z.enum(['task.complete', 'task.blocked', 'review.verdict', 'review.rework', 'dispute.raise', 'dispute.resolve', 'merge.request']),
  goalId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  actor: z.enum(['orchestrator', 'backend', 'frontend', 'reviewer']),
  timestamp: z.string().datetime().optional(),
  payload: z.record(z.unknown()).default({})
});

export class CommandBusRuntime {
  constructor(
    private readonly socketPath: string,
    private readonly store: Store,
    private readonly onEvent: (event: CommandEvent) => Promise<void>
  ) {}

  listen(): void {
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });
    const server = createServer((socket) => this.consume(socket));
    server.listen(this.socketPath, () => {
      if (process.platform !== 'win32') chmodSync(this.socketPath, 0o600);
    });
  }

  private consume(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) void this.handle(line, socket);
        index = buffer.indexOf('\n');
      }
    });
  }

  private async handle(line: string, socket: Socket): Promise<void> {
    try {
      const parsed = eventSchema.parse(JSON.parse(line));
      const event: CommandEvent = {
        version: 1,
        id: parsed.id ?? randomUUID(),
        type: parsed.type,
        goalId: parsed.goalId,
        taskId: parsed.taskId,
        actor: parsed.actor,
        timestamp: parsed.timestamp ?? new Date().toISOString(),
        payload: parsed.payload
      };
      this.store.appendEvent(event);
      await this.onEvent(event);
      socket.write(`${JSON.stringify({ ok: true, eventId: event.id })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}
