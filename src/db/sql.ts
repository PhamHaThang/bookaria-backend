/**
 * Converts a sort string to a SQL ORDER BY clause.
 * `-updatedAt` => `b.updated_at DESC` (khoá tra trong `columns`)
 * `title` => `b.title ASC`
 */
export function buildOrderBy(sort: string, columns: Record<string, string>): string {
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    const column = columns[key];
    if (!column) throw new Error(`Cột sắp xếp không hợp lệ: ${key}`);
    return `${column} ${desc ? 'DESC' : 'ASC'}`;
}

/**
 *  Escapes special characters in a string for use in a SQL LIKE clause.
 */
export function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
