import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, logger } from './config';
import { errorMiddleware, notFoundMiddleware, requestIdMiddleware } from './middlewares';
import { apiRouter } from './modules';
import { enableVietnameseMessages } from './schema';

export function createApp() {
    enableVietnameseMessages();

    const corsOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim());
    const app = express();
    app.disable('x-powered-by');
    app.use(requestIdMiddleware);
    app.use(
        pinoHttp({
            logger,
            genReqId: (_req, res) => String(res.locals.requestId),
        }),
    );
    app.use(helmet());
    app.use(cors({ origin: corsOrigins, credentials: true }));
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: true }));

    app.use('/api/v1', apiRouter);

    app.use(notFoundMiddleware);
    app.use(errorMiddleware);

    return app;
}
