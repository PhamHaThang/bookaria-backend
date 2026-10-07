import type { Response } from 'express';
import type { PaginationMeta } from '../schema';

export function ok<T>(res: Response, data: T, status = 200): void {
    res.status(status).json({ data });
}
export function created<T>(res: Response, data: T): void {
    ok(res, data, 201);
}
export function noContent(res: Response): void {
    res.status(204).end();
}
export function paginated<T>(res: Response, data: T[], meta: PaginationMeta): void {
    res.status(200).json({ data, meta });
}
