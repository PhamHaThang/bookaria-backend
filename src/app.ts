import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { corsOrigins, env, logger } from './config';
import { errorMiddleware, notFoundMiddleware, requestIdMiddleware } from './middlewares';
import { createApiRouter } from './modules';
import { enableVietnameseMessages } from './schema';

export interface AppOptions {
    rateLimit?: boolean;
}

export function createApp(options: AppOptions = {}) {
    enableVietnameseMessages();

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', env.TRUST_PROXY);
    app.use(requestIdMiddleware);
    app.use(
        pinoHttp({
            logger,
            genReqId: (req) => String(req.headers['x-request-id']),
            // Không ghi token và cookie vào log.
            redact: {
                paths: [
                    'req.url',
                    'req.headers.referer',
                    'req.headers.authorization',
                    'req.headers.cookie',
                    'res.headers["set-cookie"]',
                ],
                censor: '[REDACTED]',
            },
        }),
    );
    app.use(helmet());
    app.use(cors({ origin: corsOrigins, credentials: true }));

    const jsonDefault = express.json({ limit: '100kb' });
    const jsonScene = express.json({ limit: '512kb' });
    const jsonBookDraft = express.json({ limit: '8mb' });
    app.use((req, res, next) => {
        if (req.method === 'PUT' && /^\/api\/v1\/books\/[^/]+\/draft\/?$/i.test(req.path))
            return jsonBookDraft(req, res, next);
        if (req.method === 'PATCH' && /^\/api\/v1\/pages\/[^/]+\/scene\/?$/i.test(req.path)) {
            return jsonScene(req, res, next);
        }
        return jsonDefault(req, res, next);
    });
    app.use(express.urlencoded({ extended: true, limit: '100kb' }));
    app.use(cookieParser());

    if (env.NODE_ENV !== 'production') {
        app.use('/admin-test', express.static('public/admin-test'));
    }

    app.use('/api/v1', createApiRouter({ rateLimit: options.rateLimit ?? env.RATE_LIMIT_ENABLED }));

    app.use(notFoundMiddleware);
    app.use(errorMiddleware);

    return app;
}
