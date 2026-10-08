import type z from 'zod';
import type { ErrorCode } from './error.schema';

export type Access = 'public' | 'cookie' | 'author' | 'admin';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
    id: string; // stable operation id, e.g. "postBooks"
    method: HttpMethod;
    path: string; // after /api/v1, with :param placeholders
    access: Access;
    summary: string;
    uc: string; // use case or function code from the design tabs
    params?: z.ZodObject;
    query?: z.ZodObject;
    body?: z.ZodType;
    responses: Record<number, z.ZodType | null>; // null = no body
    errors?: ErrorCode[]; // route-specific error codes
}

/**
 * List of all API routes, for generating OpenAPI spec and route docs.
 */
export const routes: Route[] = [
    //
];
