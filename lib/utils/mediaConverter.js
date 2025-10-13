import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, readFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export class MediaConverter {
  static async convertAudioToWhatsAppFormat(audioData, originalMimeType = 'audio/webm') {
    const getExtension = (mimeType) => {
      const types = {
        'audio/webm': 'webm',
        'audio/webm; codecs=opus': 'webm',
        'audio/webm;codecs=opus': 'webm',
        'audio/mp4': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'audio/ogg': 'ogg',
        'audio/ogg; codecs=opus': 'ogg',
        'audio/aac': 'aac'
      };
      return types[mimeType] || 'webm';
    };

    const inputExt = getExtension(originalMimeType);
    const tempInputPath = join(tmpdir(), `input_${Date.now()}.${inputExt}`);
    const tempOutputPath = join(tmpdir(), `output_${Date.now()}.opus`);

    try {
      const audioBuffer = Buffer.from(audioData, 'base64');
      if (audioBuffer.length === 0) throw new Error('Empty audio data received');
      writeFileSync(tempInputPath, audioBuffer);
      if (!existsSync(tempInputPath)) throw new Error('Failed to create temporary input file');
      const fileStats = statSync(tempInputPath);
      if (fileStats.size === 0) throw new Error('Temporary file is empty');

      const command = [
        'ffmpeg -hide_banner -loglevel error',
        `-i "${tempInputPath}"`,
        '-vn',
        '-c:a libopus',
        '-b:a 24k',
        '-ar 48000',
        '-ac 1',
        '-application voip',
        '-frame_duration 20',
        `"${tempOutputPath}" -y`
      ].join(' ');
      await execAsync(command);

      if (!existsSync(tempOutputPath)) throw new Error('Output file was not created');
      const outputStats = statSync(tempOutputPath);
      if (outputStats.size === 0) throw new Error('Converted audio file is empty');

      const convertedBuffer = readFileSync(tempOutputPath);
      return { data: convertedBuffer.toString('base64'), mimetype: 'audio/ogg; codecs=opus', filename: 'voice-note.opus' };
    } catch (error) {
      console.error('Audio conversion error:', error);
      throw new Error(`Audio conversion failed: ${error.message}`);
    } finally {
      try { if (existsSync(tempInputPath)) unlinkSync(tempInputPath); } catch {}
      try { if (existsSync(tempOutputPath)) unlinkSync(tempOutputPath); } catch {}
    }
  }

  static async ensureWhatsAppImageFormat(imageData, mimetype) {
    const tempInputPath = join(tmpdir(), `img_input_${Date.now()}`);
    const tempOutputPath = join(tmpdir(), `img_output_${Date.now()}.jpg`);
    const execAsyncLocal = execAsync;

    try {
      const imageBuffer = Buffer.from(imageData, 'base64');
      writeFileSync(tempInputPath, imageBuffer);
      await execAsyncLocal(`ffmpeg -hide_banner -loglevel error -i "${tempInputPath}" -qscale:v 2 -f image2 "${tempOutputPath}" -y`);
      const convertedBuffer = readFileSync(tempOutputPath);
      return { data: convertedBuffer.toString('base64'), mimetype: 'image/jpeg', filename: 'image.jpg' };
    } finally {
      try { unlinkSync(tempInputPath); } catch {}
      try { unlinkSync(tempOutputPath); } catch {}
    }
  }
}
