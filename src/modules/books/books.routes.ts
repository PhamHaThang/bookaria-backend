import { Router } from 'express';
import { requireAuth } from '../../middlewares';
import { booksController } from './books.controller';

export const bookRouter = () => {
    const router = Router();
    router.use(requireAuth);
    // [GET] /api/v1/books
    router.get('/', booksController.getBooks);
    // [POST] /api/v1/books
    router.post('/', booksController.createBook);

    // [GET] /api/v1/books/trash
    router.get('/trash', booksController.getTrashBooks);
    // [GET] /api/v1/books/:bookId
    router.get('/:bookId', booksController.getBookById);

    // [PATCH] /api/v1/books/:bookId
    router.patch('/:bookId', booksController.updateBook);
    // [PATCH] /api/v1/books/:bookId/visibility
    router.patch('/:bookId/visibility', booksController.updateBookVisibility);

    // [DELETE] /api/v1/books/:bookId
    router.delete('/:bookId', booksController.deleteBook);
    // [POST] /api/v1/books/:bookId/restore
    router.post('/:bookId/restore', booksController.restoreBook);

    return router;
};
