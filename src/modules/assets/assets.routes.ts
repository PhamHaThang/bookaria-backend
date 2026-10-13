import { Router } from 'express';
import { UPLOAD_REQUEST_PER_MINUTE } from '../../lib';
import { rateLimitMiddleware, requireAuth } from '../../middlewares';
import { assetCategoriesController, assetController } from './assets.controller';

const MINUTE = 60 * 1000;

export const assetsRouter = (options: { rateLimit: boolean }) => {
    const router = Router();
    router.use(requireAuth);

    const enabled = options.rateLimit;

    const uploadLimit = rateLimitMiddleware({
        windowMs: MINUTE,
        limit: UPLOAD_REQUEST_PER_MINUTE,
        enabled,
        skipSuccessfulRequests: true,
    });
    // [POST] /assets/upload-signature
    router.post('/upload-signature', uploadLimit, assetController.createUploadSignature);
    // [POST] /assets/:assetId/complete
    router.post('/:assetId/complete', assetController.completeUpload);
    // [GET] /assets
    router.get('/', assetController.getAssets);
    // [GET] /assets/:assetId
    router.get('/:assetId', assetController.getAssetById);
    // [PATCH] /assets/:assetId
    router.patch('/:assetId', assetController.updateAsset);
    // [DELETE] /assets/:assetId
    router.delete('/:assetId', assetController.deleteAsset);
    // [GET] /assets/:assetId/usages
    router.get('/:assetId/usages', assetController.getAssetUsages);
    return router;
};
export const assetCategoriesRouter = () => {
    const router = Router();
    router.use(requireAuth);

    // [GET] /assets/categories
    router.get('/', assetCategoriesController.getAssetCategories);

    return router;
};
