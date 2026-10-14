import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { pagesController } from './pages.controller';

export const bookPagesRouter = () => {
    const router = Router({ mergeParams: true });
    router.use(requireAuth);

    // [GET] /api/v1/books/:bookId/pages
    router.get('/', pagesController.getBookPages);

    // [POST] /api/v1/books/:bookId/pages
    router.post('/', pagesController.addPage);

    // [PATCH] /api/v1/books/:bookId/pages/reorder
    router.patch('/reorder', pagesController.reorderPages);
    return router;
};
export const pagesRouter = () => {
    const router = Router();
    router.use(requireAuth);

    // [GET] /pages/:pageId
    router.get('/:pageId', pagesController.getPage);

    // [PATCH] /pages/:pageId
    router.patch('/:pageId', pagesController.updatePage);

    // [POST] /pages/:pageId/duplicate
    router.post('/:pageId/duplicate', pagesController.duplicatePage);

    // [PUT] /pages/:pageId/image
    router.put('/:pageId/image', pagesController.replacePageImage);

    // [GET] /pages/:pageId/marker
    router.get('/:pageId/marker', pagesController.getPageMarker);

    // [PUT] /pages/:pageId/marker
    router.put('/:pageId/marker', pagesController.updatePageMarker);

    // [POST] /pages/:pageId/marker/rescore
    router.post('/:pageId/marker/rescore', pagesController.rescorePageMarker);

    // [PATCH] /pages/:pageId/scene
    router.patch('/:pageId/scene', pagesController.saveScene);

    // [DELETE] /pages/:pageId
    router.delete('/:pageId', pagesController.deletePage);
    return router;
};
