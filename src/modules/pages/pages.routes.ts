import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { pagesController } from './pages.controller';

export const bookPagesRouter = () => {
    const router = Router({ mergeParams: true });
    router.use(requireAuth);

    // [GET] /api/books/:bookId/pages
    router.get('/', pagesController.getBookPages);

    // [POST] /api/books/:bookId/pages
    router.post('/', pagesController.addPage);

    // [PATCH] /api/books/:bookId/pages/reorder
    router.patch('/reorder', pagesController.reorderPages);
    return router;
};
export const pagesRouter = () => {
    const router = Router();
    router.use(requireAuth);

    // [GET] /api/pages/:pageId
    router.get('/:pageId', pagesController.getPage);

    // [PATCH] /api/pages/:pageId
    router.patch('/:pageId', pagesController.updatePage);

    // [POST] /api/pages/:pageId/duplicate
    router.post('/:pageId/duplicate', pagesController.duplicatePage);

    // [PUT] /api/pages/:pageId/image
    router.put('/:pageId/image', pagesController.replacePageImage);

    // [DELETE] /api/pages/:pageId
    router.delete('/:pageId', pagesController.deletePage);
    return router;
};
