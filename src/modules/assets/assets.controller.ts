import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    CompleteAssetBodySchema,
    IdSchema,
    ListAssetsQuerySchema,
    UpdateAssetBodySchema,
    UploadSignatureBodySchema,
} from '../../schema';
import { AppError } from '../../utils';
import { assetCategoriesService, assetsService } from './assets.service';

export const assetController = {
    createUploadSignature: async (req: Request, res: Response) => {
        const body = UploadSignatureBodySchema.parse(req.body);
        const result = await assetsService.createUploadSignature(getAuth(res).userId, body);
        res.status(200).json({
            data: result,
        });
    },
    completeUpload: async (req: Request, res: Response) => {
        const assetId = assetIdOf(req.params);
        const body = CompleteAssetBodySchema.parse(req.body);
        const result = await assetsService.completeUpload(getAuth(res).userId, assetId, body);
        res.status(result.status).json(result.body);
    },
    getAssets: async (req: Request, res: Response) => {
        const userId = getAuth(res).userId;
        const query = ListAssetsQuerySchema.parse(req.query);
        const result = await assetsService.getAssets(userId, query);
        res.status(200).json(result);
    },
    getAssetById: async (req: Request, res: Response) => {
        const userId = getAuth(res).userId;
        const assetId = assetIdOf(req.params);
        const asset = await assetsService.getAsset(userId, assetId);
        res.status(200).json({ data: asset });
    },
    updateAsset: async (req: Request, res: Response) => {
        const userId = getAuth(res).userId;
        const assetId = assetIdOf(req.params);
        const body = UpdateAssetBodySchema.parse(req.body);
        const asset = await assetsService.updateAsset(userId, assetId, body);
        res.status(200).json({ data: asset });
    },
    deleteAsset: async (req: Request, res: Response) => {
        const userId = getAuth(res).userId;
        const assetId = assetIdOf(req.params);
        await assetsService.deleteAsset(userId, assetId);
        res.status(204).end();
    },
    getAssetUsages: async (req: Request, res: Response) => {
        const userId = getAuth(res).userId;
        const assetId = assetIdOf(req.params);
        const usages = await assetsService.getAssetUsages(userId, assetId);
        res.status(200).json({ data: usages });
    },
};
export const assetCategoriesController = {
    getAssetCategories: async (_req: Request, res: Response) => {
        const categories = await assetCategoriesService.getCategories();
        res.status(200).json({ data: categories });
    },
};

// --- Helpers -----------------------------------------------------
function assetIdOf(params: { assetId?: string }): string {
    const parsed = IdSchema.safeParse(params.assetId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy tài nguyên.');
    return parsed.data;
}
