import { getAuth } from '../../middlewares';
import { GenerateModelBodySchema } from '../../schema';
import { asyncHandler } from '../../utils';
import { createModelGeneration, listModelGenerations } from './model-generation.service';

export const modelGenerationController = asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = getAuth(res).userId;
    if (req.method === 'GET') res.json({ data: await listModelGenerations(userId) });
    else
        res.status(202).json({
            data: await createModelGeneration(
                userId,
                GenerateModelBodySchema.parse(req.body).inputId,
            ),
        });
});
