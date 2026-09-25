import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sourceDownloadAttempts = 5;
export const SOURCE_DOWNLOAD_CONCURRENCY = 4;
const retryDelaysMs = [250, 750, 1_500, 3_000];
const sourceDownloadUserAgent = 'Chat-On-Steroids-native-source-verifier/3.1 (+https://github.com/MurphyHoops/CoS)';
const execFileAsync = promisify(execFile);

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableHttpStatus(status) {
  return status === 406 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * A second HTTP stack for hosts that selectively reject Node/Undici traffic from hosted CI.
 * This is transport redundancy only: it fetches the same reviewed URL, and the caller still
 * requires the exact reviewed byte count and SHA-256 before accepting the result.
 */
async function curlFallback(source) {
  const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const { stdout } = await execFileAsync(executable, [
    '--location',
    '--fail',
    '--silent',
    '--show-error',
    '--connect-timeout', '30',
    '--max-time', '180',
    '--header', 'Accept: */*',
    '--user-agent', sourceDownloadUserAgent,
    source.url
  ], {
    encoding: 'buffer',
    maxBuffer: source.bytes + 1024 * 1024,
    windowsHide: true
  });
  return Buffer.from(stdout);
}

/**
 * Download one reviewed native source without weakening its later byte-count / SHA-256 checks.
 * Some upstream source hosts intermittently reject bursty CI traffic with 406/429/5xx. Keep the
 * retry policy small and explicit, use a descriptive user agent, and let the caller remain the
 * integrity authority after bytes arrive.
 */
export async function downloadReviewedSource(source, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? sourceDownloadAttempts;
  const fallbackTransport = options.fallbackTransport === false
    ? null
    : options.fallbackTransport ?? curlFallback;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(source.url, {
        headers: {
          accept: '*/*',
          'user-agent': sourceDownloadUserAgent
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(180_000)
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error(`Native source download failed: ${source.file}: HTTP ${response.status}`);
        if (!isRetryableHttpStatus(response.status) || attempt === attempts) throw error;
        lastError = error;
      } else {
        if (!response.body) throw new Error(`Native source download returned no body: ${source.file}`);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > source.bytes) throw new Error(`Native source exceeds reviewed size: ${source.file}`);
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const status = /HTTP (\d{3})/.exec(message)?.[1];
      const integrityFailure = message.includes('exceeds reviewed size') || message.includes('returned no body');
      const retryable = !integrityFailure && (!status || isRetryableHttpStatus(Number(status)));
      if (!retryable) throw error;
      if (attempt === attempts) {
        if (!fallbackTransport) throw error;
        console.warn(`Falling back to second transport for native source ${source.file} after ${attempts} fetch attempts: ${message}`);
        try {
          const fallbackBytes = Buffer.from(await fallbackTransport(source));
          if (fallbackBytes.length > source.bytes) {
            throw new Error(`Native source exceeds reviewed size: ${source.file}`);
          }
          return fallbackBytes;
        } catch (fallbackError) {
          const fallbackMessage = String(fallbackError?.message ?? fallbackError);
          throw new Error(
            `Native source download failed after fetch retries and fallback transport: ${source.file}; fetch: ${message}; fallback: ${fallbackMessage}`,
            { cause: fallbackError }
          );
        }
      }
    }

    const waitMs = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1);
    console.warn(`Retrying native source ${source.file} after attempt ${attempt}/${attempts}: ${lastError?.message ?? lastError}`);
    await sleep(waitMs);
  }

  throw lastError ?? new Error(`Native source download failed: ${source.file}`);
}
