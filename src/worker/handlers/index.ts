import type { JobHandlers } from '../../modules/jobs/jobs.types';
import { optimizeAssetHandler } from '../optimize';
import { scoreMarkerHandler } from '../score';

export const handlers: JobHandlers = {
    OPTIMIZE_ASSET: optimizeAssetHandler,
    SCORE_MARKER: scoreMarkerHandler,
};
