// 1 MiB is far more than a legit hook payload; anything beyond indicates
// misuse and we bail rather than buffer an unbounded string.
const MAX_STDIN_BYTES = 1 << 20;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin payload exceeded ${MAX_STDIN_BYTES} bytes`));
        return;
      }
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

module.exports = { readStdin };
