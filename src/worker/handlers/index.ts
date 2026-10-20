import type { JobHandlers } from '../../modules/jobs/jobs.types';
import { optimizeAssetHandler } from '../optimize';
import { buildPreviewHandler } from '../preview';
import { exportPdfHandler } from '../print';
import { publishBookHandler } from '../publish';
import { scoreMarkerHandler } from '../score';

export const handlers: JobHandlers = {
    OPTIMIZE_ASSET: optimizeAssetHandler,
    SCORE_MARKER: scoreMarkerHandler,
    PUBLISH_BOOK: publishBookHandler,
    BUILD_PREVIEW: buildPreviewHandler,
    EXPORT_PDF: exportPdfHandler,
};
