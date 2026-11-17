import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import { pool } from '../../../db';
import type { InteractionAiBody } from '../../../schema/api/interaction-ai.schema';
import { SceneSchema } from '../../../schema/scene.schema';
import { completeInteraction } from '../provider';

vi.mock('../provider', () => ({ completeInteraction: vi.fn() }));
const suite = process.env.SKIP_DB_TESTS ? describe.skip : describe;
const app = createApp({ rateLimit: false });
const mock = vi.mocked(completeInteraction);
const scene = SceneSchema.parse({
    schemaVersion: 1,
    objects: [{ id: 'card', type: 'text', text: 'Rùa', transform: {} }],
});
const completion = {
    text: JSON.stringify({
        status: 'proposal',
        rule: {
            name: 'Hiện thẻ',
            trigger: { type: 'onPageEnter' },
            actions: [{ type: 'setVisible', objectId: 'card', value: true }],
        },
    }),
    model: 'test',
    inputTokens: 20,
    outputTokens: 10,
};
let token: string, otherToken: string, pageId: string, userId: string, otherId: string;
const payload = () => ({ instruction: 'Khi vào trang hiện thẻ', scene, revision: 0 });
const send = (
    body: ReturnType<typeof payload> &
        Partial<Pick<InteractionAiBody, 'history' | 'currentProposal' | 'editor'>> = payload(),
    bearer = token,
    target = app,
) =>
    request(target)
        .post(`/api/v1/pages/${pageId}/interaction-proposals`)
        .set('Authorization', `Bearer ${bearer}`)
        .send(body);

suite('AI proposals API authorization and draft isolation', () => {
    beforeAll(async () => {
        const register = async () =>
            (
                await request(app)
                    .post('/api/v1/auth/register')
                    .send({
                        email: `ai-${crypto.randomUUID()}@example.com`,
                        password: 'Matkhau-123',
                        displayName: 'AI test',
                    })
            ).body.data;
        const owner = await register(),
            other = await register();
        token = owner.accessToken;
        userId = owner.user.id;
        otherToken = other.accessToken;
        otherId = other.user.id;
        const book = await pool.query(
            "INSERT INTO books(owner_id,title) VALUES($1,'AI test') RETURNING id",
            [userId],
        );
        const image = await pool.query(
            "INSERT INTO assets(owner_id,type,name,original_public_id,resource_type,format,size_bytes,status,meta) VALUES($1,'IMAGE','test',$2,'image','png',100,'READY','{}') RETURNING id",
            [userId, crypto.randomUUID()],
        );
        const page = await pool.query(
            "INSERT INTO pages(book_id,order_index,image_asset_id,marker_mode) VALUES($1,0,$2,'NONE') RETURNING id",
            [book.rows[0].id, image.rows[0].id],
        );
        pageId = page.rows[0].id;
    });
    beforeEach(() => mock.mockResolvedValue(completion));
    afterEach(() => mock.mockReset());
    it('rejects anonymous and other owners before calling AI', async () => {
        expect(
            (
                await request(app)
                    .post(`/api/v1/pages/${pageId}/interaction-proposals`)
                    .send(payload())
            ).status,
        ).toBe(401);
        expect((await send(payload(), otherToken)).status).toBe(404);
        expect(mock).not.toHaveBeenCalled();
    });
    it('validates body/revision and scene limits before spending tokens', async () => {
        expect((await send({ ...payload(), revision: 999 })).status).toBe(409);
        expect((await send({ ...payload(), instruction: ' ' })).status).toBe(400);
        const rule = {
            id: 'x',
            trigger: { type: 'onPageEnter' },
            actions: [{ type: 'wait', ms: 1 }],
        };
        const full = SceneSchema.parse({
            ...scene,
            interactions: Array.from({ length: 50 }, (_, i) => ({ ...rule, id: `r${i}` })),
        });
        expect((await send({ ...payload(), scene: full })).status).toBe(400);
        expect(mock).not.toHaveBeenCalled();
    });
    it('uses local unsaved objects, but never persists the proposed scene', async () => {
        const before = await pool.query('SELECT scene,revision,updated_at FROM pages WHERE id=$1', [
            pageId,
        ]);
        const response = await send();
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body.data).toMatchObject({
            status: 'proposal',
            revision: 0,
            rule: { enabled: true, onRetrigger: 'ignore' },
        });
        expect(JSON.parse(mock.mock.calls[0]?.[0][1]?.content ?? 'null').objects[0].id).toBe(
            'card',
        );
        expect(
            (await pool.query('SELECT scene,revision,updated_at FROM pages WHERE id=$1', [pageId]))
                .rows,
        ).toEqual(before.rows);
    });
    it('serves an editor plan with authorized page context without changing the saved page', async () => {
        const before = await pool.query('SELECT scene,revision FROM pages WHERE id=$1', [pageId]);
        mock.mockResolvedValueOnce({
            ...completion,
            text: JSON.stringify({
                status: 'edit_plan',
                variables: [{ key: 'score', name: 'Điểm', type: 'number', initialValue: 0 }],
                rules: [
                    {
                        name: 'Cộng điểm',
                        trigger: { type: 'onTap', objectId: 'card' },
                        actions: [
                            { type: 'setState', key: 'score', operation: 'increment', value: 1 },
                        ],
                    },
                ],
            }),
        });
        const response = await send({ ...payload(), editor: { variables: [] } });
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
            status: 'edit_plan',
            plan: { rules: [{ rule: { name: 'Cộng điểm' } }], variables: [{ key: 'score' }] },
            usage: { promptVersion: 'bookaria-editor-v11' },
        });
        expect(JSON.parse(mock.mock.calls[0]?.[0][1]?.content ?? 'null')).toMatchObject({
            pages: [{ id: pageId }],
            hasMarker: false,
        });
        expect(
            (await pool.query('SELECT scene,revision FROM pages WHERE id=$1', [pageId])).rows,
        ).toEqual(before.rows);
    });
    it('passes the explicit rule scope and rejects a deleted target before calling AI', async () => {
        const rule = {
            id: 'chosen',
            name: 'Chờ',
            trigger: { type: 'onPageEnter' },
            actions: [{ type: 'wait', ms: 1000 }],
        };
        const draft = SceneSchema.parse({ ...scene, interactions: [rule] });
        mock.mockResolvedValueOnce({
            ...completion,
            text: JSON.stringify({
                status: 'edit_plan',
                variables: [],
                rules: [
                    {
                        name: rule.name,
                        trigger: rule.trigger,
                        replaceId: rule.id,
                        actions: [{ type: 'wait', ms: 2000 }],
                    },
                ],
            }),
        });
        const response = await send({
            ...payload(),
            scene: draft,
            editor: { variables: [], selectedRuleId: rule.id },
        });
        expect(response.status).toBe(200);
        expect(response.body.data.plan.rules).toMatchObject([
            { replaceId: rule.id, rule: { id: rule.id } },
        ]);
        expect(JSON.parse(mock.mock.calls[0]?.[0][1]?.content ?? 'null').selectedRuleId).toBe(
            rule.id,
        );
        mock.mockClear();
        const deleted = await send({
            ...payload(),
            editor: { variables: [], selectedRuleId: 'deleted' },
        });
        expect(deleted.status).toBe(400);
        expect(mock).not.toHaveBeenCalled();
    });
    it('passes bounded conversation with current capabilities and revalidates output after an object disappears', async () => {
        const response = await send({
            ...payload(),
            instruction: 'Dùng thẻ hiện tại',
            history: [{ role: 'assistant', content: 'Bạn muốn dùng thẻ nào?' }],
            currentProposal: {
                name: 'Cũ',
                trigger: { type: 'onPageEnter' },
                actions: [
                    {
                        type: 'setVisible',
                        objectId: 'removed',
                        value: true,
                        durationMs: 0,
                        delayMsSchema: 0,
                    },
                ],
            },
        });
        expect(response.status).toBe(200);
        const sent = JSON.parse(mock.mock.calls[0]?.[0][1]?.content ?? 'null');
        expect(sent.history).toEqual([{ role: 'assistant', content: 'Bạn muốn dùng thẻ nào?' }]);
        expect(sent.currentProposal.actions[0].objectId).toBe('removed');
        expect(response.body.data.rule.actions[0].objectId).toBe('card');
    });
    it('rejects private assets belonging to another user before sending metadata', async () => {
        const asset = await pool.query(
            "INSERT INTO assets(owner_id,type,name,original_public_id,resource_type,format,size_bytes,status,meta) VALUES($1,'AUDIO','private',$2,'video','mp3',100,'READY','{}') RETURNING id",
            [otherId, crypto.randomUUID()],
        );
        const response = await request(app)
            .post(`/api/v1/pages/${pageId}/interaction-proposals`)
            .set('Authorization', `Bearer ${token}`)
            .send({ ...payload(), audioAssetIds: [asset.rows[0].id] });
        expect(response.status).toBe(400);
        const catalogResponse = await send({
            ...payload(),
            editor: { variables: [], assetIds: [asset.rows[0].id] },
        });
        expect(catalogResponse.status).toBe(400);
        expect(mock).not.toHaveBeenCalled();
    });
    it('discards generated output when revision changes during the request', async () => {
        mock.mockImplementationOnce(async () => {
            await pool.query('UPDATE pages SET revision=revision+1 WHERE id=$1', [pageId]);
            return completion;
        });
        try {
            expect((await send()).status).toBe(409);
        } finally {
            await pool.query('UPDATE pages SET revision=0 WHERE id=$1', [pageId]);
        }
    });
    it('enforces one in-flight request per user and releases the slot after failure', async () => {
        let release!: () => void, started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        mock.mockImplementationOnce(async () => {
            started();
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            throw new Error('test failure');
        });
        const first = send().then((response) => response);
        await ready;
        expect((await send()).status).toBe(429);
        release();
        await first;
        expect((await send()).status).toBe(200);
    });
    it('rate limits requests by authenticated user', async () => {
        const limited = createApp({ rateLimit: true });
        for (let i = 0; i < 60; i++)
            expect((await send({ ...payload(), instruction: ' ' }, token, limited)).status).toBe(
                400,
            );
        const response = await send(payload(), token, limited);
        expect(response.status).toBe(429);
        expect(response.headers['retry-after']).toBeDefined();
        expect(mock).not.toHaveBeenCalled();
    });
});
