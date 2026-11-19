import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pool } from '../../db';
import { createR2Storage, derivativeKey, derivativePrefix } from '../../lib/storage';
import { account, fakeR2 } from '../../test/r2';
import { purgeDeletedAsset } from '../storage-maintenance';

const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const signal = () => new AbortController().signal;
async function fixture() {
    const owner = randomUUID(),
        id = randomUUID(),
        book = randomUUID();
    const key = `bookaria/${owner}/${id}`;
    const optimized = `bookaria/processed/${id}/${randomUUID()}-1`;
    await pool.query(
        `INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,'test','Test')`,
        [owner, `${owner}@example.test`],
    );
    await pool.query(
        `INSERT INTO assets(id,owner_id,type,name,original_public_id,optimized_public_id,resource_type,format,size_bytes,status,meta)
        VALUES ($1,$2,'IMAGE','Image',$3,$4,'image','png',10,'READY','{"width":100,"height":100}')`,
        [id, owner, key, optimized],
    );
    await pool.query('INSERT INTO books(id,owner_id,title) VALUES ($1,$2,$3)', [
        book,
        owner,
        'Test',
    ]);
    const fake = fakeR2();
    const file = { bytes: new Uint8Array(10), type: 'image/png', format: 'png' };
    const variant = derivativeKey(key, 'thumbnail');
    for (const name of [
        key,
        optimized,
        variant,
        derivativeKey(key, 'page-800-1200'),
        derivativeKey(optimized, 'cover'),
        `bookaria/thumbnails/${id}.jpg`,
        'bookaria/keep',
    ])
        fake.files.set(name, file);
    const storage = createR2Storage(account, fake.network);
    return {
        owner,
        id,
        book,
        key,
        optimized,
        variant,
        fake,
        storage,
        age: () =>
            pool.query(
                "UPDATE assets SET deleted_at=clock_timestamp()-interval '2 days' WHERE id=$1",
                [id],
            ),
        version: async (printSource: object = {}) => {
            const version = randomUUID();
            await pool.query(
                `INSERT INTO book_versions(id,book_id,version_no,schema_version,manifest_public_id,mind_groups,page_count,ar_page_count,total_size_bytes,print_source)
                VALUES ($1,$2,1,1,'bookaria/published/test','[]',1,0,1,$3::jsonb)`,
                [version, book, JSON.stringify(printSource)],
            );
            return version;
        },
    };
}
suite('R2 asset garbage collection', () => {
    it('removes original, optimized, thumbnails and all variant pages, once only', async () => {
        const f = await fixture();
        const file = { bytes: new Uint8Array(1), type: 'image/jpeg', format: 'jpg' };
        for (let i = 0; i < 105; i++)
            f.fake.files.set(`${derivativePrefix(f.key)}page-${i + 1}-100.jpg`, file);
        await f.age();
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(true);
        expect([...f.fake.files.keys()]).toEqual(['bookaria/keep']);
        expect(
            (await pool.query('SELECT storage_purged_at FROM assets WHERE id=$1', [f.id])).rows[0]
                .storage_purged_at,
        ).toBeInstanceOf(Date);
        f.fake.network.mockClear();
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(false);
        expect(f.fake.network).not.toHaveBeenCalled();
    });
    it('keeps active or recently deleted assets', async () => {
        const f = await fixture();
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(false);
        await pool.query('UPDATE assets SET deleted_at=now() WHERE id=$1', [f.id]);
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(false);
        expect(f.fake.network).not.toHaveBeenCalled();
    });
    it.each([
        'draft-page',
        'trash-page',
        'version',
        'preview-assets',
        'preview-page',
        'preview-direct',
        'print-source',
        'job',
        'snapshot-job',
        'avatar',
        'alias',
    ])('keeps resources referenced by %s', async (kind) => {
        const f = await fixture();
        if (kind === 'draft-page' || kind === 'trash-page') {
            await pool.query(
                "INSERT INTO pages(book_id,order_index,image_asset_id,marker_mode) VALUES ($1,0,$2,'NONE')",
                [f.book, f.id],
            );
            if (kind === 'trash-page')
                await pool.query('UPDATE books SET deleted_at=now() WHERE id=$1', [f.book]);
        } else if (kind === 'version') {
            const version = await f.version();
            await pool.query(
                'INSERT INTO version_assets(book_version_id,asset_id) VALUES ($1,$2)',
                [version, f.id],
            );
        } else if (kind.startsWith('preview-')) {
            const manifest =
                kind === 'preview-assets'
                    ? { assets: { [f.id]: { url: 'https://example.test/a' } } }
                    : kind === 'preview-page'
                      ? {
                            pages: [
                                {
                                    imageUrl: f.storage.deliveryUrl({
                                        resourceType: 'image',
                                        publicId: f.key,
                                        transform: 'page-800-1200',
                                    }),
                                },
                            ],
                        }
                      : { pages: [{ imageUrl: `https://assets.bookaria.test/${f.variant}` }] };
            await pool.query(
                `INSERT INTO preview_links(book_id,token,manifest,created_by,expires_at) VALUES ($1,$2,$3::jsonb,$4,now()+interval '1 hour')`,
                [f.book, randomUUID().replaceAll('-', ''), JSON.stringify(manifest), f.owner],
            );
        } else if (kind === 'print-source') {
            await f.version({ pages: [{ imagePublicId: f.key }] });
        } else if (kind === 'job' || kind === 'snapshot-job') {
            await pool.query(
                'INSERT INTO jobs(type,ref_type,ref_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
                [
                    kind === 'job' ? 'OPTIMIZE_ASSET' : 'PUBLISH_BOOK',
                    kind === 'job' ? 'ASSET' : 'BOOK',
                    kind === 'job' ? f.id : f.book,
                    JSON.stringify(kind === 'job' ? {} : { snapshot: { assets: [{ id: f.id }] } }),
                ],
            );
        } else if (kind === 'avatar') {
            await pool.query('UPDATE users SET avatar_url=$2 WHERE id=$1', [
                f.owner,
                `https://assets.bookaria.test/${f.variant}`,
            ]);
        } else {
            await pool.query(
                `INSERT INTO assets(owner_id,type,name,original_public_id,resource_type,format,size_bytes,status) VALUES ($1,'IMAGE','Alias',$2,'image','png',10,'READY')`,
                [f.owner, f.key],
            );
        }
        await f.age();
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(false);
        expect(f.fake.network).not.toHaveBeenCalled();
    });
    it('allows cleanup after a preview expires, including its one-hour request grace', async () => {
        const f = await fixture();
        await pool.query(
            `INSERT INTO preview_links(book_id,token,manifest,created_by,expires_at) VALUES ($1,$2,$3::jsonb,$4,now()-interval '2 hours')`,
            [
                f.book,
                randomUUID().replaceAll('-', ''),
                JSON.stringify({ assets: { [f.id]: {} } }),
                f.owner,
            ],
        );
        await f.age();
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(true);
    });
    it('retains retry state after a failed deletion and succeeds on retry', async () => {
        const f = await fixture();
        await f.age();
        const fail = {
            ...f.storage,
            destroy: vi.fn<typeof f.storage.destroy>().mockRejectedValueOnce(new Error('offline')),
        };
        await expect(purgeDeletedAsset(f.id, fail, signal())).rejects.toThrow('offline');
        expect(
            (await pool.query('SELECT storage_purged_at FROM assets WHERE id=$1', [f.id])).rows[0]
                .storage_purged_at,
        ).toBeNull();
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(true);
    });
    it('does not delete external or unexpected object keys', async () => {
        const f = await fixture();
        await f.age();
        await pool.query(
            "UPDATE assets SET original_public_id='https://external.test/file' WHERE id=$1",
            [f.id],
        );
        expect(await purgeDeletedAsset(f.id, f.storage, signal())).toBe(false);
        expect(f.fake.network).not.toHaveBeenCalled();
    });
    it('rejects an out-of-prefix listing before deleting any objects', async () => {
        const f = await fixture();
        await f.age();
        const unsafe = {
            ...f.storage,
            listKeys: vi.fn(async () => ({ keys: ['bookaria/keep'], next: undefined })),
        };
        await expect(purgeDeletedAsset(f.id, unsafe, signal())).rejects.toThrow('ngoài prefix');
        expect(f.fake.network).not.toHaveBeenCalled();
    });
    it('uses row locks to prevent two workers from deleting the same asset', async () => {
        const f = await fixture();
        await f.age();
        const result = await Promise.all([
            purgeDeletedAsset(f.id, f.storage, signal()),
            purgeDeletedAsset(f.id, f.storage, signal()),
        ]);
        expect(result.sort()).toEqual([false, true]);
        expect(
            f.fake.network.mock.calls.filter(
                ([r]) =>
                    (r as Request).method === 'DELETE' &&
                    new URL((r as Request).url).pathname.endsWith(f.key),
            ),
        ).toHaveLength(1);
    });
});
