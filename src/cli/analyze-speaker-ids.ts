import path from 'node:path';
import { analyzeRepeatedSpeakerIds } from '../services/speaker-id-analysis.js';

const jsonOutput = process.argv.includes('--json');
const directoryArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const metadataDirectory = path.resolve(directoryArgument ?? 'src/callradar-data/metadata');
const result = await analyzeRepeatedSpeakerIds(metadataDirectory);

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Metadata files scanned: ${result.filesScanned}`);
  console.log(`Invalid metadata entries: ${result.invalidFiles.length}`);
  console.log(`Repeated role/speaker IDs: ${result.repeated.length}`);
  console.log(`IDs appearing as both agent and caller: ${result.idsAppearingInBothRoles.join(', ') || 'none'}`);
  console.log('');
  console.log('ROLE\tSPEAKER_ID\tOCCURRENCES\tNAMES');
  for (const item of result.repeated) {
    console.log(`${item.role}\t${item.speakerId}\t${item.count}\t${item.names.join(', ') || 'Unknown'}`);
  }
}

if (result.invalidFiles.length > 0) process.exitCode = 1;
