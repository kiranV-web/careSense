import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';

export interface StoredObject {
  bucket: string;
  key: string;
  url: string;
  checksum: string;
  bytes: number;
}

export class ObjectStorage {
  readonly client: S3Client;

  constructor(private readonly config: Config) {
    const credentials = {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY
    };
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT ?? `https://${config.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: config.R2_FORCE_PATH_STYLE,
      credentials
    });
  }

  async ready(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.R2_BUCKET_NAME }));
  }

  async upload(key: string, source: NodeJS.ReadableStream, contentType: string): Promise<StoredObject> {
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    source.pipe(meter);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.config.R2_BUCKET_NAME, Key: key, Body: meter, ContentType: contentType },
      queueSize: 2,
      partSize: 5 * 1024 * 1024
    });
    await upload.done();
    const publicBase = this.config.R2_PUBLIC_BASE_URL?.replace(/\/$/, '');
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const endpoint = this.config.R2_ENDPOINT?.replace(/\/$/, '');
    const url = publicBase
      ? `${publicBase}/${encodedKey}`
      : endpoint
        ? `${endpoint}/${encodeURIComponent(this.config.R2_BUCKET_NAME)}/${encodedKey}`
        : `https://${this.config.R2_BUCKET_NAME}.${this.config.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodedKey}`;
    return { bucket: this.config.R2_BUCKET_NAME, key, url, checksum: hash.digest('hex'), bytes };
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.R2_BUCKET_NAME, Key: key }));
  }

  async downloadToFile(key: string, destination: string): Promise<void> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.R2_BUCKET_NAME, Key: key }));
    if (!result.Body) throw new Error(`R2 object has no body: ${key}`);
    await pipeline(result.Body as Readable, createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
  }

  async openReadStream(key: string, range?: { start: number; end: number }): Promise<{
    stream: Readable;
    contentLength?: number;
    contentRange?: string;
    contentType?: string;
  }> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.R2_BUCKET_NAME,
      Key: key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined
    }));
    if (!result.Body) throw new Error(`R2 object has no body: ${key}`);
    return {
      stream: result.Body as Readable,
      contentLength: result.ContentLength,
      contentRange: result.ContentRange,
      contentType: result.ContentType
    };
  }
}
