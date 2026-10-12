import type { Request, Response } from 'express';
import { getAuth } from '../../middlewares';
import {
    CreateBookBodySchema,
    IdSchema,
    ListBooksQuerySchema,
    PaginationQuerySchema,
    UpdateBookBodySchema,
    UpdateVisibilityBodySchema,
} from '../../schema';
import { AppError, asyncHandler } from '../../utils';
import { booksService } from './books.service';
export const booksController = {
    getBooks: asyncHandler(async (req: Request, res: Response) => {
        const q = ListBooksQuerySchema.parse(req.query);
        const { rows, meta } = await booksService.getBooks(getAuth(res).userId, q);
        res.json({ data: rows, meta });
    }),
    getTrashBooks: asyncHandler(async (req: Request, res: Response) => {
        const q = PaginationQuerySchema.parse(req.query);
        const { rows, meta } = await booksService.getTrashBooks(getAuth(res).userId, q);
        res.json({ data: rows, meta });
    }),
    getBookById: asyncHandler(async (req: Request, res: Response) => {
        const bookId = bookIdOf(req.params);
        const book = await booksService.getBookById(getAuth(res).userId, bookId);
        res.json({ data: book });
    }),
    createBook: asyncHandler(async (req: Request, res: Response) => {
        const body = CreateBookBodySchema.parse(req.body);
        const result = await booksService.createBook(getAuth(res).userId, body);
        res.status(201).json({ data: result });
    }),
    updateBook: asyncHandler(async (req: Request, res: Response) => {
        const bookId = bookIdOf(req.params);
        const body = UpdateBookBodySchema.parse(req.body);
        const result = await booksService.updateBook(getAuth(res).userId, bookId, body);
        res.json({ data: result });
    }),
    updateBookVisibility: asyncHandler(async (req: Request, res: Response) => {
        const bookId = bookIdOf(req.params);
        const body = UpdateVisibilityBodySchema.parse(req.body);
        const result = await booksService.setVisibility(
            getAuth(res).userId,
            bookId,
            body.visibility,
        );
        res.json({ data: result });
    }),
    deleteBook: asyncHandler(async (req: Request, res: Response) => {
        await booksService.deleteBook(getAuth(res).userId, bookIdOf(req.params));
        res.status(204).send();
    }),
    restoreBook: asyncHandler(async (req: Request, res: Response) => {
        const result = await booksService.restoreBook(getAuth(res).userId, bookIdOf(req.params));
        res.json({ data: result });
    }),
};
// --- Helpers ---------------------------------------------------------------------
function bookIdOf(params: { bookId?: string }): string {
    const parsed = IdSchema.safeParse(params.bookId);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Không tìm thấy sách.');
    return parsed.data;
}
