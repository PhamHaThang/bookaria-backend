import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { publishController } from './publish.controller';

export const publishRouter = () => {
    const router = Router({ mergeParams: true });
    router.use(requireAuth);

    // [GET] /books/:bookId/publish-check
    router.get('/publish-check', publishController.publishCheck);

    // [POST] /books/:bookId/publish
    router.post('/publish', publishController.publishBook);

    // [GET] /books/:bookId/versions
    router.get('/versions', publishController.getBookVersions);

    // [GET] /books/:bookId/share
    router.get('/share', publishController.getShareInfo);

    // [POST] /books/:bookId/unpublish
    router.post('/unpublish', publishController.unpublishBook);

    return router;
};
