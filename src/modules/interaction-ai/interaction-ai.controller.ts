import { getAuth } from '../../middlewares';
import { InteractionAiBodySchema } from '../../schema/api/interaction-ai.schema';
import { IdSchema } from '../../schema/common.schema';
import { asyncHandler } from '../../utils';
import { createInteractionProposal } from './interaction-ai.service';

export const interactionAiController = asyncHandler(async (req, res) => {
    const controller = new AbortController();
    const close = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.on('close', close);
    try {
        const data = await createInteractionProposal(
            getAuth(res).userId,
            IdSchema.parse(req.params.pageId),
            InteractionAiBodySchema.parse(req.body),
            controller.signal,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.json({ data });
    } finally {
        res.off('close', close);
    }
});
