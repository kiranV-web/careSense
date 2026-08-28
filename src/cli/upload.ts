import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import FormData from 'form-data';

const archivePath = process.argv[2];
const apiBaseUrl = (process.argv[3] ?? 'http://localhost:3000').replace(/\/$/, '');
if (!archivePath) {
  console.error('Usage: npm run upload:batch -- <archive.zip> [api-base-url]');
  process.exit(1);
}
if (!archivePath.toLowerCase().endsWith('.zip')) throw new Error('Archive must have a .zip extension');

const details = await stat(archivePath);
const form = new FormData();
form.append('archive', createReadStream(archivePath), { filename: path.basename(archivePath), knownLength: details.size });
const contentLength = await new Promise<number>((resolve, reject) => {
  form.getLength((error, length) => error ? reject(error) : resolve(length));
});
let lastPercentage = -1;
const response = await axios.post(`${apiBaseUrl}/api/v1/upload-batches`, form, {
  headers: { ...form.getHeaders(), 'Content-Length': contentLength },
  maxBodyLength: Infinity,
  onUploadProgress(event) {
    const percentage = Math.min(100, Math.round((event.loaded / contentLength) * 100));
    if (percentage !== lastPercentage) {
      lastPercentage = percentage;
      process.stdout.write(`\rUpload: ${percentage}%`);
    }
  }
});
process.stdout.write('\n');
console.log(JSON.stringify(response.data, null, 2));
