import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const MAGIC_0 = 0x4c; // 'L'
const MAGIC_1 = 0x48; // 'H'
const FORMAT = 1;
const FLAG_GZIP = 1 << 0;
const FLAG_AES = 1 << 1;

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * blob 编解码：默认 gzip 压缩；开启加密时再套一层 AES-256-GCM。
 * 口令保存在 VSCode SecretStorage 中，不会写进工作区。
 */
export class BlobCodec {
  private key?: Buffer;
  private keySalt?: Buffer;

  constructor(private passphrase?: string) {}

  get encrypted(): boolean {
    return !!this.passphrase;
  }

  setPassphrase(passphrase: string | undefined): void {
    this.passphrase = passphrase;
    this.key = undefined;
    this.keySalt = undefined;
  }

  async encode(text: string): Promise<Uint8Array> {
    const payload = await gzip(Buffer.from(text, 'utf8'));
    if (!this.passphrase) {
      return Buffer.concat([header(FLAG_GZIP), payload]);
    }
    const salt = crypto.randomBytes(SALT_LEN);
    const key = await this.deriveKey(salt);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([header(FLAG_GZIP | FLAG_AES), salt, iv, cipher.getAuthTag(), enc]);
  }

  async decode(data: Uint8Array): Promise<string> {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (buf.length < 4 || buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) {
      // 没有头部的旧数据：按未压缩的 utf8 处理
      return buf.toString('utf8');
    }
    const flags = buf[3];
    let payload = buf.subarray(4);
    if (flags & FLAG_AES) {
      if (!this.passphrase) {
        throw new Error('历史内容已加密，请先设置加密口令（Local History: 设置历史存储加密口令）。');
      }
      const salt = payload.subarray(0, SALT_LEN);
      const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN);
      const tag = payload.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
      const body = payload.subarray(SALT_LEN + IV_LEN + TAG_LEN);
      const key = await this.deriveKey(Buffer.from(salt));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      payload = Buffer.concat([decipher.update(body), decipher.final()]);
    }
    if (flags & FLAG_GZIP) {
      return (await gunzip(payload)).toString('utf8');
    }
    return payload.toString('utf8');
  }

  private async deriveKey(salt: Buffer): Promise<Buffer> {
    if (this.key && this.keySalt && this.keySalt.equals(salt)) {
      return this.key;
    }
    const pass = this.passphrase!;
    const key = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(pass, salt, 32, (err, derived) => (err ? reject(err) : resolve(derived as Buffer)));
    });
    this.key = key;
    this.keySalt = salt;
    return key;
  }
}

function header(flags: number): Buffer {
  return Buffer.from([MAGIC_0, MAGIC_1, FORMAT, flags]);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}
