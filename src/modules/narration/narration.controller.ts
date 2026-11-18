import { getAuth } from '../../middlewares';
import { NarrationBodySchema } from '../../schema/api/narration.schema';
import { asyncHandler } from '../../utils';
import { generateNarration, narrationVoices } from './narration.service';

export const narrationController = asyncHandler(async (req, res) => {
    const controller = new AbortController();
    const close = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.on('close', close);
    res.setHeader('Cache-Control', 'no-store');
    try {
        const userId = getAuth(res).userId;
        if (req.method === 'GET') {
            res.json({ data: await narrationVoices(controller.signal) });
        } else {
            const audio = await generateNarration(
                userId,
                NarrationBodySchema.parse(req.body),
                controller.signal,
            );
            res.setHeader('Content-Disposition', 'attachment; filename="narration.mp3"');
            res.type('audio/mpeg').send(audio);
        }
    } finally {
        res.off('close', close);
    }
});
