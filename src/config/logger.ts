import { execFileSync } from 'node:child_process';
import pino from 'pino';
import { env } from './env';

if (process.platform === 'win32' && (process.stdout.isTTY || process.stderr.isTTY)) {
    execFileSync('chcp.com', ['65001'], { stdio: 'ignore' });
}

export const logger = pino({
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',

    ...(env.NODE_ENV === 'development' && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname',
            },
        },
    }),
});
