import { Injectable } from '@nestjs/common';
import { Client } from 'minio';

import type { ObjectStore } from '../../application/ports.js';

/** MinIO behind the ObjectStore port. S3, GCS or Blob swap in here (ADR-012). */
@Injectable()
export class MinioObjectStore implements ObjectStore {
  constructor(private readonly client: Client) {}

  async ensureBucket(bucket: string): Promise<void> {
    if (!(await this.client.bucketExists(bucket))) {
      await this.client.makeBucket(bucket);
    }
  }

  async presignUpload(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    const url = await this.client.presignedPutObject(
      input.bucket,
      input.key,
      input.expiresInSeconds,
    );
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) };
  }

  async stat(input: { bucket: string; key: string }): Promise<{ sizeBytes: number } | null> {
    try {
      const stat = await this.client.statObject(input.bucket, input.key);
      return { sizeBytes: stat.size };
    } catch {
      // Absent is a normal answer here -- the client may not have uploaded yet.
      return null;
    }
  }

  open(input: { bucket: string; key: string }): Promise<NodeJS.ReadableStream> {
    // A stream, not a Buffer: a large PDF must not be resident in the worker.
    return this.client.getObject(input.bucket, input.key);
  }

  async remove(input: { bucket: string; key: string }): Promise<void> {
    await this.client.removeObject(input.bucket, input.key);
  }
}
