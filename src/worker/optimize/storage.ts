import { probeMedia, videoThumbnail } from '../../lib/media-processing';
import { createR2Storage, type R2Account } from '../../lib/storage';
import type { AssetRow } from '../../modules/assets/assets.types';
import { ASSET_MAX_BYTES, MODEL_MAX_DOWNLOAD_BYTES } from '../../schema';
import { modelThumbnail } from './model-thumbnail';

interface InspectedAsset {
    bytes: number;
    format: string;
    width?: number;
    height?: number;
    duration?: number;
    source?: Uint8Array;
}

export function createProcessingStorage(account: R2Account, network: typeof fetch = fetch) {
    const media = createR2Storage(account, network);
    return {
        async download(asset: AssetRow, signal: AbortSignal) {
            return media.get(asset.original_public_id, ASSET_MAX_BYTES[asset.type], signal);
        },
        async uploadModel(key: string, bytes: Uint8Array, signal: AbortSignal) {
            await media.put(key, bytes, 'model/gltf-binary', 'glb', signal);
        },
        async thumbnail(asset: AssetRow, signal: AbortSignal, source?: Uint8Array) {
            const key = `bookaria/thumbnails/${asset.id}.jpg`;
            if (!(await media.head(key, signal))) {
                const optimized = asset.type === 'MODEL' ? asset.optimized_public_id : null;
                const bytes =
                    source ??
                    (await media.get(
                        optimized ?? asset.original_public_id,
                        optimized ? MODEL_MAX_DOWNLOAD_BYTES : ASSET_MAX_BYTES[asset.type],
                        signal,
                    ));
                const thumbnail =
                    asset.type === 'MODEL'
                        ? await modelThumbnail(bytes, signal)
                        : await videoThumbnail(bytes, signal);
                try {
                    await media.put(key, thumbnail, 'image/jpeg', 'jpg', signal);
                } catch (error) {
                    if (!(await media.head(key, signal))) throw error;
                }
            }
            return media.publicUrl(key);
        },
        async inspect(asset: AssetRow, signal: AbortSignal): Promise<InspectedAsset> {
            signal.throwIfAborted();
            if (asset.type === 'VIDEO') {
                const source = await media.get(
                    asset.original_public_id,
                    ASSET_MAX_BYTES.VIDEO,
                    signal,
                );
                const metadata = await probeMedia(source, signal);
                return {
                    source,
                    bytes: source.byteLength,
                    format: metadata.format,
                    duration: metadata.duration,
                    ...(metadata.width !== null && { width: metadata.width }),
                    ...(metadata.height !== null && { height: metadata.height }),
                };
            }
            const stored = await media.inspect(asset.resource_type, asset.original_public_id);
            if (!stored) throw new Error('Không tìm thấy tài nguyên R2.');
            return {
                bytes: stored.bytes,
                format: stored.format,
                ...(stored.durationSec !== null && { duration: stored.durationSec }),
                ...(stored.width !== null && { width: stored.width }),
                ...(stored.height !== null && { height: stored.height }),
            };
        },
    };
}
export type ProcessingStorage = ReturnType<typeof createProcessingStorage>;
