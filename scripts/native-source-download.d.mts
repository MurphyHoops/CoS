export const SOURCE_DOWNLOAD_CONCURRENCY: number;

export interface ReviewedNativeSource {
  file: string;
  url: string;
  bytes: number;
}

export interface NativeSourceDownloadOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export function downloadReviewedSource(
  source: ReviewedNativeSource,
  options?: NativeSourceDownloadOptions
): Promise<Buffer>;
