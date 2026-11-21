import type { JobHandlers } from '../../modules/jobs/jobs.types';
import { optimizeAssetHandler } from '../optimize';
import { buildPreviewHandler } from '../preview';
import { exportPdfHandler } from '../print';
import { publishBookHandler } from '../publish';
import { scoreMarkerHandler } from '../score';
import { generateModelHandler } from './generate-model';

export const handlers: JobHandlers = {
    GENERATE_MODEL: generateModelHandler,
    OPTIMIZE_ASSET: optimizeAssetHandler,
    SCORE_MARKER: scoreMarkerHandler,
    PUBLISH_BOOK: publishBookHandler,
    BUILD_PREVIEW: buildPreviewHandler,
    EXPORT_PDF: exportPdfHandler,
};
