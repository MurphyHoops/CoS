import { describe, expect, it, vi } from 'vitest';
import { downloadReviewedSource, SOURCE_DOWNLOAD_CONCURRENCY } from '../scripts/native-source-download.mjs';

const source = {
  file: 'example.tar.gz',
  url: 'https://sources.example.invalid/example.tar.gz',
  bytes: 3
};

describe('native source release downloads', () => {
  it('keeps release download concurrency bounded', () => {
    expect(SOURCE_DOWNLOAD_CONCURRENCY).toBe(4);
  });

  it('retries a transient 406 and returns the later reviewed bytes', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('blocked', { status: 406 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const bytes = await downloadReviewedSource(source, {
      fetchImpl,
      sleep: async (ms: number) => { sleeps.push(ms); }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([250]);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ accept: '*/*' });
  });

  it('retries nonstandard 5xx edge responses instead of enumerating only common server errors', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('edge failure', { status: 520 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const bytes = await downloadReviewedSource(source, { fetchImpl, sleep: async () => {} });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('falls back to a second transport only after retryable fetch attempts are exhausted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValue(new Response('blocked', { status: 406 }));
    const fallbackTransport = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

    const bytes = await downloadReviewedSource(source, {
      fetchImpl,
      fallbackTransport,
      attempts: 2,
      sleep: async () => {}
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fallbackTransport).toHaveBeenCalledTimes(1);
    expect(fallbackTransport).toHaveBeenCalledWith(source);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('does not let the fallback transport bypass the reviewed size bound', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('blocked', { status: 406 }));
    const fallbackTransport = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    await expect(downloadReviewedSource(source, {
      fetchImpl,
      fallbackTransport,
      attempts: 1,
      sleep: async () => {}
    })).rejects.toThrow('exceeds reviewed size');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fallbackTransport).toHaveBeenCalledTimes(1);
  });

  it('surfaces fallback transport failure after retryable fetch attempts are exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('blocked', { status: 406 }));
    const fallbackTransport = vi.fn().mockRejectedValue(new Error('curl exited 22'));

    await expect(downloadReviewedSource(source, {
      fetchImpl,
      fallbackTransport,
      attempts: 2,
      sleep: async () => {}
    })).rejects.toThrow('fallback transport');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fallbackTransport).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient HTTP failures or oversized content', async () => {
    const fallbackTransport = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const notFound = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));
    await expect(downloadReviewedSource(source, { fetchImpl: notFound, fallbackTransport, sleep: async () => {} }))
      .rejects.toThrow('HTTP 404');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(fallbackTransport).not.toHaveBeenCalled();

    const oversized = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    await expect(downloadReviewedSource(source, { fetchImpl: oversized, fallbackTransport, sleep: async () => {} }))
      .rejects.toThrow('exceeds reviewed size');
    expect(oversized).toHaveBeenCalledTimes(1);
    expect(fallbackTransport).not.toHaveBeenCalled();
  });
});
