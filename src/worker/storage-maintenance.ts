import { logger } from '../config';
import { pool, withTransaction } from '../db';
import { createR2Storage, derivativePrefix, r2Account } from '../lib/storage';
import type { AssetRow } from '../modules/assets/assets.types';

type Storage = Pick<ReturnType<typeof createR2Storage>, 'destroy' | 'listKeys'>;
const BATCH = 100;
const INTERVAL = 60 * 60 * 1000;

/** Only delete app-managed objects, never external library URLs or arbitrary bucket prefixes. */
function managedKeys(asset: AssetRow) {
    if (!new RegExp(`^bookaria/[a-f0-9-]{36}/${asset.id}$`).test(asset.original_public_id)) return;
    if (
        asset.optimized_public_id &&
        !new RegExp(`^bookaria/processed/${asset.id}/[a-f0-9-]{36}-[0-9]+$`).test(
            asset.optimized_public_id,
        )
    )
        return;
    return [asset.original_public_id, asset.optimized_public_id].filter(
        (key): key is string => !!key,
    );
}

export async function purgeDeletedAsset(id: string, storage: Storage, signal: AbortSignal) {
    return withTransaction(async (db) => {
        const result = await db.query<AssetRow>(
            `SELECT * FROM assets WHERE id=$1
            AND deleted_at < clock_timestamp()-interval '24 hours' AND storage_purged_at IS NULL
            FOR UPDATE SKIP LOCKED`,
            [id],
        );
        const asset = result.rows[0];
        if (!asset) return false;
        const keys = managedKeys(asset);
        if (!keys) return false;
        const tokens = [
            ...keys,
            ...keys.map(encodeURIComponent),
            ...keys.map(derivativePrefix),
            ...(asset.thumbnail_url ? [asset.thumbnail_url] : []),
        ];
        const protection = await db.query<{ used: boolean }>(
            `SELECT (
            EXISTS (SELECT 1 FROM pages WHERE image_asset_id=$1 OR marker_mind_public_id=ANY($2::text[])) OR
            EXISTS (SELECT 1 FROM page_assets WHERE asset_id=$1) OR
            EXISTS (SELECT 1 FROM books WHERE cover_asset_id=$1) OR
            EXISTS (SELECT 1 FROM version_assets WHERE asset_id=$1) OR
            EXISTS (SELECT 1 FROM bookaria_markers WHERE image_public_id=ANY($2::text[]) OR mind_public_id=ANY($2::text[])) OR
            EXISTS (SELECT 1 FROM assets a WHERE a.id<>$1 AND a.storage_purged_at IS NULL
                AND (a.original_public_id=ANY($2::text[]) OR a.optimized_public_id=ANY($2::text[]) OR EXISTS (
                    SELECT 1 FROM unnest($3::text[]) t WHERE strpos(a.original_public_id,t)>0 OR
                    strpos(a.optimized_public_id,t)>0 OR strpos(a.thumbnail_url,t)>0))) OR
            EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('QUEUED','RUNNING') AND (
                (j.ref_type='ASSET' AND j.ref_id=$1) OR strpos(j.payload::text,$1::text)>0 OR
                EXISTS (SELECT 1 FROM unnest($3::text[]) t WHERE strpos(j.payload::text,t)>0))) OR
            EXISTS (SELECT 1 FROM preview_links p WHERE p.expires_at > clock_timestamp()-interval '1 hour'
                AND (p.manifest->'assets' ? $1::text OR EXISTS (
                    SELECT 1 FROM unnest($3::text[]) t WHERE strpos(p.manifest::text,t)>0))) OR
            EXISTS (SELECT 1 FROM book_versions v WHERE EXISTS (
                SELECT 1 FROM unnest($3::text[]) t WHERE strpos(v.print_source::text,t)>0)) OR
            EXISTS (SELECT 1 FROM users u WHERE EXISTS (
                SELECT 1 FROM unnest($3::text[]) t WHERE strpos(u.avatar_url,t)>0))
        ) AS used`,
            [id, keys, tokens],
        );
        if (protection.rows[0]?.used !== false) return false;
        for (const key of keys) {
            let continuation: string | undefined;
            const seen = new Set<string>();
            const variants: string[] = [];
            do {
                signal.throwIfAborted();
                const prefix = derivativePrefix(key);
                const page = await storage.listKeys(prefix, continuation, signal);
                for (const variant of page.keys) {
                    if (!variant.startsWith(prefix))
                        throw new Error('Từ chối xóa tệp ngoài prefix ảnh.');
                    variants.push(variant);
                }
                continuation = page.next;
                if (continuation) {
                    if (seen.has(continuation) || seen.size >= 100)
                        throw new Error('Phân trang R2 không hợp lệ.');
                    seen.add(continuation);
                }
            } while (continuation);
            for (const variant of variants) await storage.destroy('raw', variant, signal);
            await storage.destroy('raw', key, signal);
        }
        await storage.destroy('raw', `bookaria/thumbnails/${id}.jpg`, signal);
        signal.throwIfAborted();
        await db.query('UPDATE assets SET storage_purged_at=clock_timestamp() WHERE id=$1', [id]);
        return true;
    });
}

// shortcut: collects deleted assets only; add upload/job orphan collection when abandoned files accumulate.
export function startStorageMaintenance() {
    const controller = new AbortController();
    const storage = createR2Storage(r2Account());
    let cursor: string | undefined;
    let running: Promise<void> | undefined;
    const tick = () => {
        if (running || controller.signal.aborted) return;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
        running = (async () => {
            const result = await pool.query<{ id: string }>(
                `SELECT id FROM assets
                WHERE deleted_at < clock_timestamp()-interval '24 hours' AND storage_purged_at IS NULL
                AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
                [cursor ?? null, BATCH],
            );
            let purged = 0;
            for (const { id } of result.rows) {
                signal.throwIfAborted();
                try {
                    if (await purgeDeletedAsset(id, storage, signal)) purged++;
                } catch (error) {
                    signal.throwIfAborted();
                    logger.warn({ err: error, assetId: id }, 'Chưa dọn được tài nguyên R2');
                }
            }
            cursor = result.rows.length === BATCH ? result.rows.at(-1)?.id : undefined;
            if (purged) logger.info({ purged }, 'Đã dọn tài nguyên R2 không còn sử dụng');
        })()
            .catch((error) => {
                if (!controller.signal.aborted)
                    logger.error({ err: error }, 'Bảo trì R2 chưa hoàn tất');
            })
            .finally(() => {
                running = undefined;
            });
    };
    const timer = setInterval(tick, INTERVAL);
    timer.unref();
    tick();
    return async () => {
        controller.abort();
        clearInterval(timer);
        await running;
    };
}
