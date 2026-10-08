/**
 * Fail closed when the original CoS app or its original tunnel client is live.
 * CoS Next is a different application identity and never triggers this guard.
 * Do not treat the presence of an original install as a running process.
 */
export function originalCoSProcessActive(processCommandLines: string): boolean {
  return processCommandLines.split('\n').some(line =>
    line.includes('/Chat On Steroids.app/Contents/MacOS/') ||
    line.includes('/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client'));
}
