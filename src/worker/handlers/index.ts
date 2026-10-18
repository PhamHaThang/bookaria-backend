import type { JobHandlers } from '../../modules/jobs/jobs.types';
import { optimizeAssetHandler } from '../optimize';

export const handlers: JobHandlers = {
    OPTIMIZE_ASSET: optimizeAssetHandler,
};
