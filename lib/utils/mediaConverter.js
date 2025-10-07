import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, readFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export class MediaConverter {
  static async convertAudioToWhatsAppFormat(audioData, originalMimeType = 'audio/webm') {
    // Determine the correct file extension from MIME type
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
    // IMPORTANT: write to .opus so ffmpeg picks the Opus-in-Ogg muxer & correct headers
    const tempOutputPath = join(tmpdir(), `output_${Date.now()}.opus`);
    
    try {
      // Write input file with proper validation
      const audioBuffer = Buffer.from(audioData, 'base64');
      
      // Validate the buffer isn't empty
      if (audioBuffer.length === 0) {
        throw new Error('Empty audio data received');
      }
      
      writeFileSync(tempInputPath, audioBuffer);
      
      // Verify the file was written and has content
      if (!existsSync(tempInputPath)) {
        throw new Error('Failed to create temporary input file');
      }
      
      const fileStats = statSync(tempInputPath);
      if (fileStats.size === 0) {
        throw new Error('Temporary file is empty');
      }

      console.log(`Converting audio: ${inputExt} -> opus, size: ${audioBuffer.length} bytes, mime: ${originalMimeType}`);
      
      // Convert to WhatsApp-compatible Opus-in-Ogg voice note
      // Let the .opus extension select the correct muxer; tune for VOIP PTT
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
      console.log(`Executing conversion: ${command}`);
      
      await execAsync(command);
      
      // Verify output file was created and has content
      if (!existsSync(tempOutputPath)) {
        throw new Error('Output file was not created');
      }
      
      const outputStats = statSync(tempOutputPath);
      if (outputStats.size === 0) {
        throw new Error('Converted audio file is empty');
      }
      
      const convertedBuffer = readFileSync(tempOutputPath);
      
      return {
        data: convertedBuffer.toString('base64'),
        // Opus inside Ogg container
        mimetype: 'audio/ogg; codecs=opus',
        // using .opus helps some stacks; wwebjs still uses the mimetype above
        filename: 'voice-note.opus'
      };
    } catch (error) {
      console.error('Audio conversion error:', error);
      throw new Error(`Audio conversion failed: ${error.message}`);
    } finally {
      // Clean up temp files
      try { if (existsSync(tempInputPath)) unlinkSync(tempInputPath); } catch (e) {}
      try { if (existsSync(tempOutputPath)) unlinkSync(tempOutputPath); } catch (e) {}
    }
  }

  static async ensureWhatsAppImageFormat(imageData, mimetype) {
    // Convert various image formats to JPEG for better WhatsApp compatibility
    const tempInputPath = join(tmpdir(), `img_input_${Date.now()}`);
    const tempOutputPath = join(tmpdir(), `img_output_${Date.now()}.jpg`);
    
    try {
      const imageBuffer = Buffer.from(imageData, 'base64');
      writeFileSync(tempInputPath, imageBuffer);
      
      await execAsync(`ffmpeg -hide_banner -loglevel error -i "${tempInputPath}" -qscale:v 2 -f image2 "${tempOutputPath}" -y`);
      
      const convertedBuffer = readFileSync(tempOutputPath);
      return {
        data: convertedBuffer.toString('base64'),
        mimetype: 'image/jpeg',
        filename: 'image.jpg'
      };
    } finally {
      try { unlinkSync(tempInputPath); } catch (e) {}
      try { unlinkSync(tempOutputPath); } catch (e) {}
    }
  }
}
